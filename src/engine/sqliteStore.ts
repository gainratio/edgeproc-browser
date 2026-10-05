// The content-addressed store, as SQLite tables on the library's own SQL seam:
//
//   chunk(hash PRIMARY KEY, size, body BLOB)   verbatim zstd, as fetched
//   manifest(hash PRIMARY KEY, body BLOB)      manifest bytes, as fetched
//   active_pointer(id = 1, pointer, floor_sequence, floor_identity)
//
// The read path is unchanged from the OPFS file store it replaces: decompress
// → sha256 → compare to the row's name, fail closed, and evict a row that
// fails so the next sync re-fetches it. The anti-rollback floor sits in the
// same row as the pointer, a trigger makes it impossible to lower with an
// UPDATE, and promote() commits pointer + floor in ONE transaction that also
// writes the still-pending chunks and proves every chunk the release needs is
// present. A torn write is a rolled-back transaction, so there is no
// write-order protocol left to get wrong.

import type { SqlBind, SqlExecResult, SqlRow } from "../sql/types.js";
import {
	canPromotePointer,
	parseStoredPointer,
	samePointer,
	selectHighestPointer,
} from "./activePointer.js";
import { sha256Hex } from "./crypto.js";
import { decompressAndVerify, IntegrityError } from "./integrity.js";
import { RollbackError } from "./sync.js";
import type { CacheStore, VersionPointer } from "./types.js";

/** The slice of the in-Worker SqlEngine this store needs. */
export interface ChunkSqlConnection {
	exec(sql: string, bind?: SqlBind): SqlExecResult;
	query(sql: string, bind?: SqlBind): SqlRow[];
	/** BEGIN IMMEDIATE … COMMIT around `work`; a throw rolls it back. */
	immediate<T>(work: () => T): T;
}

/** A verified chunk ready to insert: `size` is its plaintext length. */
export interface VerifiedChunk {
	readonly hash: string;
	readonly size: number;
	readonly body: Uint8Array;
}

export interface LegacyImport {
	readonly chunks: ReadonlyArray<VerifiedChunk>;
	readonly manifests: ReadonlyArray<{
		readonly hash: string;
		readonly body: Uint8Array;
	}>;
	readonly pointers: ReadonlyArray<VersionPointer | null>;
}

export type MigrationState = "none" | "copied" | "done";

export const CHUNK_SCHEMA_VERSION = 1;
const MAX_COMPRESSED_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
/** Ingest is committed in batches: bounded memory, few transactions. */
const FLUSH_CHUNKS = 64;
const FLUSH_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECODER = new TextDecoder();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunk(
	hash TEXT PRIMARY KEY NOT NULL CHECK (length(hash) = 64),
	size INTEGER NOT NULL CHECK (size >= 0),
	body BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS manifest(
	hash TEXT PRIMARY KEY NOT NULL CHECK (length(hash) = 64),
	body BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS active_pointer(
	id INTEGER PRIMARY KEY CHECK (id = 1),
	pointer TEXT,
	floor_sequence INTEGER NOT NULL,
	floor_identity TEXT
);
CREATE TRIGGER IF NOT EXISTS active_pointer_floor_monotonic
BEFORE UPDATE OF floor_sequence ON active_pointer
WHEN NEW.floor_sequence < OLD.floor_sequence
BEGIN SELECT RAISE(ABORT, 'rollback floor may not decrease'); END;
CREATE TABLE IF NOT EXISTS legacy_migration(
	id INTEGER PRIMARY KEY CHECK (id = 1),
	state TEXT NOT NULL CHECK (state IN ('copied', 'done'))
);
`;

interface FloorRow {
	readonly pointer: VersionPointer | null;
	readonly floorSequence: number;
	readonly floorIdentity: string | null;
}

export class SqliteCacheStore implements CacheStore {
	readonly #db: ChunkSqlConnection;
	readonly #pending = new Map<string, VerifiedChunk>();
	#pendingBytes = 0;

	private constructor(db: ChunkSqlConnection) {
		this.#db = db;
	}

	/** Create the schema if needed. Incremental auto-vacuum is set before the
	 * first table exists, so pruned pages can be handed back to the browser. */
	public static open(db: ChunkSqlConnection): SqliteCacheStore {
		const version = Number(db.query("PRAGMA user_version")[0]?.user_version);
		if (version > CHUNK_SCHEMA_VERSION) {
			throw new Error(
				`chunk store schema ${version} is newer than this build (${CHUNK_SCHEMA_VERSION})`,
			);
		}
		if (version < CHUNK_SCHEMA_VERSION) {
			db.exec("PRAGMA auto_vacuum = INCREMENTAL");
			db.immediate(() => {
				db.exec(SCHEMA);
				db.exec(`PRAGMA user_version = ${CHUNK_SCHEMA_VERSION}`);
			});
		}
		return new SqliteCacheStore(db);
	}

	public async hasChunk(chunkHash: string): Promise<boolean> {
		if (this.#pending.has(chunkHash)) return true;
		const rows = this.#db.query(
			"SELECT 1 AS present FROM chunk WHERE hash = ?",
			[chunkHash],
		);
		return rows.length > 0;
	}

	public async putChunkCompressed(
		chunkHash: string,
		compressed: Uint8Array,
		expectedSize: number,
	): Promise<void> {
		if (compressed.byteLength === 0) {
			throw new IntegrityError("compressed chunk must not be empty");
		}
		if (compressed.byteLength > MAX_COMPRESSED_CHUNK_BYTES) {
			throw new IntegrityError("compressed chunk exceeds the store read cap");
		}
		// Verify BEFORE it can reach a row (fail-closed).
		await decompressAndVerify(chunkHash, compressed, expectedSize);
		if (this.#pending.has(chunkHash)) return;
		this.#pending.set(chunkHash, {
			hash: chunkHash,
			size: expectedSize,
			body: compressed.slice(),
		});
		this.#pendingBytes += compressed.byteLength;
		if (
			this.#pending.size >= FLUSH_CHUNKS ||
			this.#pendingBytes >= FLUSH_BYTES
		) {
			await this.flush();
		}
	}

	/** Commit verified chunks still held in memory (one transaction). */
	public async flush(): Promise<void> {
		if (this.#pending.size === 0) return;
		this.#db.immediate(() => this.#insertPending());
		this.#clearPending();
	}

	public async getChunk(
		chunkHash: string,
		expectedSize: number,
	): Promise<Uint8Array> {
		// Reads always come from the table, never from the ingest buffer.
		await this.flush();
		const row = this.#db.query("SELECT size, body FROM chunk WHERE hash = ?", [
			chunkHash,
		])[0];
		if (row === undefined) throw new Error(`chunk ${chunkHash} not in store`);
		try {
			const body = row.body;
			if (!(body instanceof Uint8Array) || body.byteLength === 0) {
				throw new IntegrityError(`chunk ${chunkHash} is empty or not a BLOB`);
			}
			if (body.byteLength > MAX_COMPRESSED_CHUNK_BYTES) {
				throw new IntegrityError(`chunk ${chunkHash} exceeds the read cap`);
			}
			return await decompressAndVerify(chunkHash, body, expectedSize);
		} catch (error) {
			// Self-heal: a row that fails its content address is corrupt or
			// tampered. Evict it so hasChunk goes false and the next sync
			// re-fetches it; the read itself still fails closed.
			if (error instanceof IntegrityError) {
				this.#db.exec("DELETE FROM chunk WHERE hash = ?", [chunkHash]);
			}
			throw error;
		}
	}

	public async putManifest(manifestBytes: Uint8Array): Promise<string> {
		if (
			manifestBytes.byteLength === 0 ||
			manifestBytes.byteLength > MAX_MANIFEST_BYTES
		) {
			throw new IntegrityError("manifest is empty or exceeds the read cap");
		}
		const hash = await sha256Hex(manifestBytes);
		this.#db.exec(
			"INSERT INTO manifest(hash, body) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET body = excluded.body",
			[hash, manifestBytes],
		);
		return hash;
	}

	public async getManifest(manifestHash: string): Promise<Uint8Array> {
		const body = this.#db.query("SELECT body FROM manifest WHERE hash = ?", [
			manifestHash,
		])[0]?.body;
		if (body === undefined) {
			throw new Error(`manifest ${manifestHash} not in store`);
		}
		if (
			!(body instanceof Uint8Array) ||
			body.byteLength > MAX_MANIFEST_BYTES ||
			(await sha256Hex(body)) !== manifestHash
		) {
			this.#db.exec("DELETE FROM manifest WHERE hash = ?", [manifestHash]);
			throw new IntegrityError(
				`manifest ${manifestHash} failed content-address check`,
			);
		}
		return body;
	}

	/** The pointer to serve, only if the floor gate admits it: a row edited to
	 * an older or forked release at rest is not served (fails closed to null;
	 * the next online sync re-promotes under the same gate). */
	public async readActive(): Promise<VersionPointer | null> {
		const row = this.#readRow();
		return row.pointer !== null && admits(row, row.pointer)
			? row.pointer
			: null;
	}

	/** The highest sequence ever promoted here; -1 when there is none. */
	public async readFloor(): Promise<number> {
		return this.#readRow().floorSequence;
	}

	public async promote(
		pointer: VersionPointer,
		chunks?: ReadonlyArray<string>,
	): Promise<void> {
		this.#db.immediate(() => {
			this.#insertPending();
			if (chunks !== undefined) this.#assertPresent(chunks);
			const row = this.#readRow();
			if (!admits(row, pointer)) {
				throw new RollbackError(
					`refusing to promote sequence ${pointer.sequence} over the durable floor ${row.floorSequence}`,
				);
			}
			this.#writeRow(installPointer(row, pointer));
		});
		this.#clearPending();
	}

	public async clearActiveIf(expected: VersionPointer): Promise<boolean> {
		return this.#db.immediate(() => {
			const row = this.#readRow();
			if (!samePointer(row.pointer, expected)) return false;
			this.#writeRow({ ...row, pointer: null });
			return true;
		});
	}

	/** Eviction is a DELETE of everything the active release does not use,
	 * then an incremental vacuum so the freed pages leave the file. With
	 * `secure_delete` on (the SQL seam sets it for OPFS), deleted bytes are
	 * overwritten, not just unlinked. */
	public async pruneInactive(): Promise<void> {
		await this.flush();
		const active = await this.readActive();
		if (active === null) return;
		let keep: ReadonlySet<string> | null;
		try {
			keep = activeChunkHashes(
				JSON.parse(
					DECODER.decode(await this.getManifest(active.manifest_hash)),
				) as unknown,
			);
		} catch {
			return;
		}
		if (keep === null) return;
		this.#db.immediate(() => {
			this.#db.exec(
				"DELETE FROM chunk WHERE hash NOT IN (SELECT value FROM json_each(?))",
				[JSON.stringify([...keep])],
			);
			this.#db.exec("DELETE FROM manifest WHERE hash <> ?", [
				active.manifest_hash,
			]);
		});
		this.#db.exec("PRAGMA incremental_vacuum");
	}

	/** The explicit reset: chunks, manifests, the pointer AND the floor. */
	public async clear(): Promise<void> {
		this.#clearPending();
		this.#db.immediate(() => {
			this.#db.exec("DELETE FROM chunk");
			this.#db.exec("DELETE FROM manifest");
			this.#db.exec("DELETE FROM active_pointer");
		});
		this.#db.exec("PRAGMA incremental_vacuum");
	}

	public migrationState(): MigrationState {
		const state = this.#db.query(
			"SELECT state FROM legacy_migration WHERE id = 1",
		)[0]?.state;
		return state === "copied" || state === "done" ? state : "none";
	}

	/**
	 * Copy a legacy store in ONE transaction: chunks and manifests (already
	 * verified by the caller), and the legacy pointers as a floor that can
	 * only raise this one. Idempotent: running it twice changes nothing.
	 */
	public importLegacy(input: LegacyImport): void {
		this.#db.immediate(() => {
			this.#insertRows(input.chunks);
			for (const manifest of input.manifests) {
				this.#db.exec(
					"INSERT OR IGNORE INTO manifest(hash, body) VALUES (?, ?)",
					[manifest.hash, manifest.body],
				);
			}
			this.#writeRow(mergeLegacyFloor(this.#readRow(), input.pointers));
			this.#db.exec(
				"INSERT INTO legacy_migration(id, state) VALUES (1, 'copied') ON CONFLICT(id) DO UPDATE SET state = 'copied' WHERE state <> 'done'",
			);
		});
	}

	/** Raise (never lower) the floor with legacy pointers; one transaction,
	 * migration state untouched. */
	public raiseLegacyFloor(
		pointers: ReadonlyArray<VersionPointer | null>,
	): void {
		this.#db.immediate(() => {
			this.#writeRow(mergeLegacyFloor(this.#readRow(), pointers));
		});
	}

	public markMigrationDone(): void {
		this.#db.exec(
			"INSERT INTO legacy_migration(id, state) VALUES (1, 'done') ON CONFLICT(id) DO UPDATE SET state = 'done'",
		);
	}

	#insertPending(): void {
		this.#insertRows([...this.#pending.values()]);
	}

	#insertRows(rows: ReadonlyArray<VerifiedChunk>): void {
		for (const chunk of rows) {
			this.#db.exec(
				"INSERT OR IGNORE INTO chunk(hash, size, body) VALUES (?, ?, ?)",
				[chunk.hash, chunk.size, chunk.body],
			);
		}
	}

	#clearPending(): void {
		this.#pending.clear();
		this.#pendingBytes = 0;
	}

	#assertPresent(chunks: ReadonlyArray<string>): void {
		const wanted = [...new Set(chunks)];
		const present = Number(
			this.#db.query(
				"SELECT count(*) AS n FROM chunk WHERE hash IN (SELECT value FROM json_each(?))",
				[JSON.stringify(wanted)],
			)[0]?.n,
		);
		if (present !== wanted.length) {
			throw new IntegrityError(
				`refusing to promote: missing ${wanted.length - present} of ${wanted.length} chunks`,
			);
		}
	}

	#readRow(): FloorRow {
		const row = this.#db.query(
			"SELECT pointer, floor_sequence, floor_identity FROM active_pointer WHERE id = 1",
		)[0];
		if (row === undefined) {
			return { pointer: null, floorSequence: -1, floorIdentity: null };
		}
		return {
			pointer: parsePointerText(row.pointer),
			floorSequence: Number(row.floor_sequence),
			floorIdentity:
				typeof row.floor_identity === "string" ? row.floor_identity : null,
		};
	}

	#writeRow(row: FloorRow): void {
		this.#db.exec(
			`INSERT INTO active_pointer(id, pointer, floor_sequence, floor_identity)
			 VALUES (1, :pointer, :floor, :identity)
			 ON CONFLICT(id) DO UPDATE SET pointer = excluded.pointer,
			   floor_sequence = excluded.floor_sequence,
			   floor_identity = excluded.floor_identity`,
			{
				":pointer": row.pointer === null ? null : JSON.stringify(row.pointer),
				":floor": row.floorSequence,
				":identity": row.floorIdentity,
			},
		);
	}
}

/** The fields `samePointer` compares, in a fixed order: one string per release. */
export function pointerIdentity(pointer: VersionPointer): string {
	return JSON.stringify([
		pointer.manifest_hash,
		pointer.version,
		pointer.sequence ?? null,
		pointer.signature,
		pointer.bundle_id ?? null,
		pointer.channel ?? null,
		pointer.key_id ?? null,
		pointer.expires_at ?? null,
	]);
}

function sequenceOf(pointer: VersionPointer): number {
	return Number.isSafeInteger(pointer.sequence) && pointer.sequence >= 0
		? pointer.sequence
		: -1;
}

/**
 * THE floor gate. Every path that sets the active pointer (promote, legacy
 * import, the in-memory fallback's legacy floor) and the path that serves it
 * (readActive, so offline loads too) asks this one function.
 * With a floor: a higher sequence, or the exact release at the floor.
 * Without one (nothing sequenced yet): the 0.2.x promotion rule.
 */
function admits(row: FloorRow, incoming: VersionPointer): boolean {
	if (row.floorSequence < 0) {
		return canPromotePointer(row.pointer, incoming);
	}
	const sequence = sequenceOf(incoming);
	if (sequence !== row.floorSequence) return sequence > row.floorSequence;
	return row.floorIdentity === pointerIdentity(incoming);
}

/** Only after admits(): the pointer, and a floor that can only rise. */
function installPointer(row: FloorRow, pointer: VersionPointer): FloorRow {
	return {
		pointer,
		floorSequence: Math.max(row.floorSequence, sequenceOf(pointer)),
		floorIdentity: pointerIdentity(pointer),
	};
}

/** Raise (never lower) the floor with legacy pointers, through the same gate
 * as promote(). Legacy slots that disagree at their highest sequence leave a
 * floor with NO identity, so only a strictly newer release is admitted. */
function mergeLegacyFloor(
	row: FloorRow,
	pointers: ReadonlyArray<VersionPointer | null>,
): FloorRow {
	let legacy: VersionPointer | null;
	try {
		legacy = selectHighestPointer(pointers);
	} catch {
		return conflictingLegacyFloor(row, pointers);
	}
	if (legacy === null) return row;
	if (admits(row, legacy)) {
		// A pre-sequence (0.1.x) pointer never displaces an active release.
		if (sequenceOf(legacy) < 0 && row.pointer !== null) return row;
		return installPointer(row, legacy);
	}
	// Refused: lower (ours stands) or a fork at our floor (trust neither).
	return sequenceOf(legacy) === row.floorSequence
		? { ...row, floorIdentity: null }
		: row;
}

function conflictingLegacyFloor(
	row: FloorRow,
	pointers: ReadonlyArray<VersionPointer | null>,
): FloorRow {
	const sequence = Math.max(
		-1,
		...pointers.flatMap((item) => (item === null ? [] : [sequenceOf(item)])),
	);
	if (sequence > row.floorSequence) {
		return { pointer: null, floorSequence: sequence, floorIdentity: null };
	}
	return sequence === row.floorSequence ? { ...row, floorIdentity: null } : row;
}

function parsePointerText(value: unknown): VersionPointer | null {
	if (typeof value !== "string") return null;
	try {
		return parseStoredPointer(JSON.parse(value) as unknown);
	} catch {
		return null;
	}
}

function activeChunkHashes(manifest: unknown): ReadonlySet<string> | null {
	if (typeof manifest !== "object" || manifest === null) return null;
	const files = (manifest as { files?: unknown }).files;
	if (!Array.isArray(files)) return null;
	const hashes = new Set<string>();
	for (const file of files) {
		const chunks = (file as { chunks?: unknown } | null)?.chunks;
		if (!Array.isArray(chunks)) return null;
		for (const chunk of chunks) {
			const hash = (chunk as { hash?: unknown } | null)?.hash;
			if (typeof hash !== "string" || !SHA256.test(hash)) return null;
			hashes.add(hash);
		}
	}
	return hashes;
}
