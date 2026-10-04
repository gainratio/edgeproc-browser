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
import { canPromotePointer, parseStoredPointer, samePointer, selectHighestPointer, } from "./activePointer.js";
import { sha256Hex } from "./crypto.js";
import { decompressAndVerify, IntegrityError } from "./integrity.js";
import { RollbackError } from "./sync.js";
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
export class SqliteCacheStore {
    #db;
    #pending = new Map();
    #pendingBytes = 0;
    constructor(db) {
        this.#db = db;
    }
    /** Create the schema if needed. Incremental auto-vacuum is set before the
     * first table exists, so pruned pages can be handed back to the browser. */
    static open(db) {
        const version = Number(db.query("PRAGMA user_version")[0]?.user_version);
        if (version > CHUNK_SCHEMA_VERSION) {
            throw new Error(`chunk store schema ${version} is newer than this build (${CHUNK_SCHEMA_VERSION})`);
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
    async hasChunk(chunkHash) {
        if (this.#pending.has(chunkHash))
            return true;
        const rows = this.#db.query("SELECT 1 AS present FROM chunk WHERE hash = ?", [chunkHash]);
        return rows.length > 0;
    }
    async putChunkCompressed(chunkHash, compressed, expectedSize) {
        if (compressed.byteLength === 0) {
            throw new IntegrityError("compressed chunk must not be empty");
        }
        if (compressed.byteLength > MAX_COMPRESSED_CHUNK_BYTES) {
            throw new IntegrityError("compressed chunk exceeds the store read cap");
        }
        // Verify BEFORE it can reach a row (fail-closed).
        await decompressAndVerify(chunkHash, compressed, expectedSize);
        if (this.#pending.has(chunkHash))
            return;
        this.#pending.set(chunkHash, {
            hash: chunkHash,
            size: expectedSize,
            body: compressed.slice(),
        });
        this.#pendingBytes += compressed.byteLength;
        if (this.#pending.size >= FLUSH_CHUNKS ||
            this.#pendingBytes >= FLUSH_BYTES) {
            await this.flush();
        }
    }
    /** Commit verified chunks still held in memory (one transaction). */
    async flush() {
        if (this.#pending.size === 0)
            return;
        this.#db.immediate(() => this.#insertPending());
        this.#clearPending();
    }
    async getChunk(chunkHash, expectedSize) {
        // Reads always come from the table, never from the ingest buffer.
        await this.flush();
        const row = this.#db.query("SELECT size, body FROM chunk WHERE hash = ?", [
            chunkHash,
        ])[0];
        if (row === undefined)
            throw new Error(`chunk ${chunkHash} not in store`);
        try {
            const body = row.body;
            if (!(body instanceof Uint8Array) || body.byteLength === 0) {
                throw new IntegrityError(`chunk ${chunkHash} is empty or not a BLOB`);
            }
            if (body.byteLength > MAX_COMPRESSED_CHUNK_BYTES) {
                throw new IntegrityError(`chunk ${chunkHash} exceeds the read cap`);
            }
            return await decompressAndVerify(chunkHash, body, expectedSize);
        }
        catch (error) {
            // Self-heal: a row that fails its content address is corrupt or
            // tampered. Evict it so hasChunk goes false and the next sync
            // re-fetches it; the read itself still fails closed.
            if (error instanceof IntegrityError) {
                this.#db.exec("DELETE FROM chunk WHERE hash = ?", [chunkHash]);
            }
            throw error;
        }
    }
    async putManifest(manifestBytes) {
        if (manifestBytes.byteLength === 0 ||
            manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
            throw new IntegrityError("manifest is empty or exceeds the read cap");
        }
        const hash = await sha256Hex(manifestBytes);
        this.#db.exec("INSERT INTO manifest(hash, body) VALUES (?, ?) ON CONFLICT(hash) DO UPDATE SET body = excluded.body", [hash, manifestBytes]);
        return hash;
    }
    async getManifest(manifestHash) {
        const body = this.#db.query("SELECT body FROM manifest WHERE hash = ?", [
            manifestHash,
        ])[0]?.body;
        if (body === undefined) {
            throw new Error(`manifest ${manifestHash} not in store`);
        }
        if (!(body instanceof Uint8Array) ||
            body.byteLength > MAX_MANIFEST_BYTES ||
            (await sha256Hex(body)) !== manifestHash) {
            this.#db.exec("DELETE FROM manifest WHERE hash = ?", [manifestHash]);
            throw new IntegrityError(`manifest ${manifestHash} failed content-address check`);
        }
        return body;
    }
    async readActive() {
        return this.#readRow().pointer;
    }
    /** The highest sequence ever promoted here; -1 when there is none. */
    async readFloor() {
        return this.#readRow().floorSequence;
    }
    async promote(pointer, chunks) {
        this.#db.immediate(() => {
            this.#insertPending();
            if (chunks !== undefined)
                this.#assertPresent(chunks);
            const row = this.#readRow();
            if (!promotable(row, pointer)) {
                throw new RollbackError(`refusing to promote sequence ${pointer.sequence} over the durable floor ${row.floorSequence}`);
            }
            this.#writeRow({
                pointer,
                floorSequence: Math.max(row.floorSequence, sequenceOf(pointer)),
                floorIdentity: pointerIdentity(pointer),
            });
        });
        this.#clearPending();
    }
    async clearActiveIf(expected) {
        return this.#db.immediate(() => {
            const row = this.#readRow();
            if (!samePointer(row.pointer, expected))
                return false;
            this.#writeRow({ ...row, pointer: null });
            return true;
        });
    }
    /** Eviction is a DELETE of everything the active release does not use,
     * then an incremental vacuum so the freed pages leave the file. With
     * `secure_delete` on (the SQL seam sets it for OPFS), deleted bytes are
     * overwritten, not just unlinked. */
    async pruneInactive() {
        await this.flush();
        const active = await this.readActive();
        if (active === null)
            return;
        let keep;
        try {
            keep = activeChunkHashes(JSON.parse(DECODER.decode(await this.getManifest(active.manifest_hash))));
        }
        catch {
            return;
        }
        if (keep === null)
            return;
        this.#db.immediate(() => {
            this.#db.exec("DELETE FROM chunk WHERE hash NOT IN (SELECT value FROM json_each(?))", [JSON.stringify([...keep])]);
            this.#db.exec("DELETE FROM manifest WHERE hash <> ?", [
                active.manifest_hash,
            ]);
        });
        this.#db.exec("PRAGMA incremental_vacuum");
    }
    /** The explicit reset: chunks, manifests, the pointer AND the floor. */
    async clear() {
        this.#clearPending();
        this.#db.immediate(() => {
            this.#db.exec("DELETE FROM chunk");
            this.#db.exec("DELETE FROM manifest");
            this.#db.exec("DELETE FROM active_pointer");
        });
        this.#db.exec("PRAGMA incremental_vacuum");
    }
    migrationState() {
        const state = this.#db.query("SELECT state FROM legacy_migration WHERE id = 1")[0]?.state;
        return state === "copied" || state === "done" ? state : "none";
    }
    /**
     * Copy a legacy store in ONE transaction: chunks and manifests (already
     * verified by the caller), and the legacy pointers as a floor that can
     * only raise this one. Idempotent: running it twice changes nothing.
     */
    importLegacy(input) {
        this.#db.immediate(() => {
            this.#insertRows(input.chunks);
            for (const manifest of input.manifests) {
                this.#db.exec("INSERT OR IGNORE INTO manifest(hash, body) VALUES (?, ?)", [manifest.hash, manifest.body]);
            }
            this.#writeRow(mergeLegacyFloor(this.#readRow(), input.pointers));
            this.#db.exec("INSERT INTO legacy_migration(id, state) VALUES (1, 'copied') ON CONFLICT(id) DO UPDATE SET state = 'copied' WHERE state <> 'done'");
        });
    }
    markMigrationDone() {
        this.#db.exec("INSERT INTO legacy_migration(id, state) VALUES (1, 'done') ON CONFLICT(id) DO UPDATE SET state = 'done'");
    }
    #insertPending() {
        this.#insertRows([...this.#pending.values()]);
    }
    #insertRows(rows) {
        for (const chunk of rows) {
            this.#db.exec("INSERT OR IGNORE INTO chunk(hash, size, body) VALUES (?, ?, ?)", [chunk.hash, chunk.size, chunk.body]);
        }
    }
    #clearPending() {
        this.#pending.clear();
        this.#pendingBytes = 0;
    }
    #assertPresent(chunks) {
        const wanted = [...new Set(chunks)];
        const present = Number(this.#db.query("SELECT count(*) AS n FROM chunk WHERE hash IN (SELECT value FROM json_each(?))", [JSON.stringify(wanted)])[0]?.n);
        if (present !== wanted.length) {
            throw new IntegrityError(`refusing to promote: missing ${wanted.length - present} of ${wanted.length} chunks`);
        }
    }
    #readRow() {
        const row = this.#db.query("SELECT pointer, floor_sequence, floor_identity FROM active_pointer WHERE id = 1")[0];
        if (row === undefined) {
            return { pointer: null, floorSequence: -1, floorIdentity: null };
        }
        return {
            pointer: parsePointerText(row.pointer),
            floorSequence: Number(row.floor_sequence),
            floorIdentity: typeof row.floor_identity === "string" ? row.floor_identity : null,
        };
    }
    #writeRow(row) {
        this.#db.exec(`INSERT INTO active_pointer(id, pointer, floor_sequence, floor_identity)
			 VALUES (1, :pointer, :floor, :identity)
			 ON CONFLICT(id) DO UPDATE SET pointer = excluded.pointer,
			   floor_sequence = excluded.floor_sequence,
			   floor_identity = excluded.floor_identity`, {
            ":pointer": row.pointer === null ? null : JSON.stringify(row.pointer),
            ":floor": row.floorSequence,
            ":identity": row.floorIdentity,
        });
    }
}
/** The fields `samePointer` compares, in a fixed order: one string per release. */
export function pointerIdentity(pointer) {
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
function sequenceOf(pointer) {
    return Number.isSafeInteger(pointer.sequence) && pointer.sequence >= 0
        ? pointer.sequence
        : -1;
}
function promotable(row, incoming) {
    if (row.floorSequence < 0) {
        return canPromotePointer(row.pointer, incoming);
    }
    const sequence = sequenceOf(incoming);
    if (sequence !== row.floorSequence)
        return sequence > row.floorSequence;
    return row.floorIdentity === pointerIdentity(incoming);
}
/** Raise (never lower) the floor with legacy pointers. Legacy slots that
 * disagree at their highest sequence leave a floor with NO identity, so only
 * a strictly newer release can be promoted over it. */
function mergeLegacyFloor(row, pointers) {
    let legacy;
    try {
        legacy = selectHighestPointer(pointers);
    }
    catch {
        const sequence = Math.max(-1, ...pointers.flatMap((item) => (item === null ? [] : [sequenceOf(item)])));
        return sequence > row.floorSequence
            ? { pointer: null, floorSequence: sequence, floorIdentity: null }
            : row.floorSequence === sequence
                ? { ...row, floorIdentity: null }
                : row;
    }
    if (legacy === null)
        return row;
    const sequence = sequenceOf(legacy);
    if (sequence > row.floorSequence) {
        return {
            pointer: legacy,
            floorSequence: sequence,
            floorIdentity: pointerIdentity(legacy),
        };
    }
    if (sequence < 0) {
        // A pre-sequence (0.1.x) pointer carries no floor; keep it only as the
        // release to serve offline, and only if nothing is active yet.
        return row.pointer === null && row.floorSequence < 0
            ? { ...row, pointer: legacy }
            : row;
    }
    if (sequence < row.floorSequence)
        return row;
    if (row.floorIdentity === pointerIdentity(legacy)) {
        return { ...row, pointer: row.pointer ?? legacy };
    }
    return { ...row, floorIdentity: null };
}
function parsePointerText(value) {
    if (typeof value !== "string")
        return null;
    try {
        return parseStoredPointer(JSON.parse(value));
    }
    catch {
        return null;
    }
}
function activeChunkHashes(manifest) {
    if (typeof manifest !== "object" || manifest === null)
        return null;
    const files = manifest.files;
    if (!Array.isArray(files))
        return null;
    const hashes = new Set();
    for (const file of files) {
        const chunks = file?.chunks;
        if (!Array.isArray(chunks))
            return null;
        for (const chunk of chunks) {
            const hash = chunk?.hash;
            if (typeof hash !== "string" || !SHA256.test(hash))
                return null;
            hashes.add(hash);
        }
    }
    return hashes;
}
//# sourceMappingURL=sqliteStore.js.map