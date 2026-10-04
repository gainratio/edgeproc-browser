// One-time move from the 0.2.x stores into SQLite. Steps, each safe to crash:
//   0. read every legacy FLOOR and raise ours with it (one transaction); if a
//      floor cannot be read, stop: LegacyFloorUnavailableError, fail closed
//   1. read every legacy store (nothing changes if a read fails)
//   2. verify each chunk by its content address; drop what fails
//   3. ONE transaction: insert chunks + manifests, raise the floor (never
//      lower it), record state "copied"
//   4. check every copied chunk is present
//   5. delete the legacy stores, then record "done"
// A crash before 3 leaves nothing changed; between 3 and 5 the next boot
// re-runs 1–5, which is idempotent (INSERT OR IGNORE, floor = max). Chunks
// that are not migrated are simply re-downloaded by the next sync.

import { sha256Hex } from "./crypto.js";
import {
	decompressAndVerify,
	MAX_DECOMPRESSED_CHUNK_BYTES,
} from "./integrity.js";
import type { SqliteCacheStore, VerifiedChunk } from "./sqliteStore.js";
import type { VersionPointer } from "./types.js";
import { declaredContentSize } from "./zstd.js";

export interface LegacySnapshot {
	readonly chunks: ReadonlyArray<{
		readonly hash: string;
		readonly body: Uint8Array;
	}>;
	readonly manifests: ReadonlyArray<{
		readonly hash: string;
		readonly body: Uint8Array;
	}>;
	/** Structurally valid durable pointers; signatures are not re-checked
	 * because a floor only refuses, it never grants trust. */
	readonly pointers: ReadonlyArray<VersionPointer | null>;
}

/** A 0.2.x store: its floor alone, the whole store, then delete it. */
export interface LegacySource {
	readonly label: string;
	/** Only the durable pointers (the rollback floor). Small and read first. */
	readPointers(): Promise<ReadonlyArray<VersionPointer | null>>;
	read(): Promise<LegacySnapshot>;
	remove(): Promise<void>;
}

/** A 0.2.x rollback floor exists but could not be read. Nothing may be
 * promoted until it is (or the user explicitly resets the cache): accepting
 * a release without it could accept a rollback the old floor would refuse. */
export class LegacyFloorUnavailableError extends Error {
	public constructor(cause: unknown) {
		super(
			`legacy rollback floor unavailable (storage): ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "LegacyFloorUnavailableError";
	}
}

/** Raise the store's floor with every legacy source's pointers (never lower
 * it). Throws LegacyFloorUnavailableError, changing nothing, if any source's
 * floor cannot be read. Read-only on the legacy side. */
export async function importLegacyFloor(
	store: SqliteCacheStore,
	sources: ReadonlyArray<LegacySource>,
): Promise<void> {
	let pointers: ReadonlyArray<VersionPointer | null>;
	try {
		pointers = (
			await Promise.all(sources.map((source) => source.readPointers()))
		).flat();
	} catch (error) {
		throw new LegacyFloorUnavailableError(error);
	}
	store.raiseLegacyFloor(pointers);
}

export interface MigrationReport {
	readonly state: "already-done" | "migrated";
	readonly copiedChunks: number;
	readonly skippedChunks: number;
	readonly floor: number;
}

const SHA256 = /^[0-9a-f]{64}$/u;

export async function migrateLegacyStores(
	store: SqliteCacheStore,
	sources: ReadonlyArray<LegacySource>,
): Promise<MigrationReport> {
	if (store.migrationState() === "done") {
		return {
			state: "already-done",
			copiedChunks: 0,
			skippedChunks: 0,
			floor: await store.readFloor(),
		};
	}
	// The floor first, on its own: whatever happens to the bulk copy below,
	// the old floor is already in force (or nothing runs at all).
	await importLegacyFloor(store, sources);
	const snapshots = await Promise.all(sources.map((source) => source.read()));
	const { chunks, skipped } = await verifiedChunks(snapshots);
	const manifests = await verifiedManifests(snapshots);
	store.importLegacy({
		chunks,
		manifests,
		pointers: snapshots.flatMap((snapshot) => snapshot.pointers),
	});
	for (const chunk of chunks) {
		if (!(await store.hasChunk(chunk.hash))) {
			throw new Error(`migrated chunk ${chunk.hash} is missing after commit`);
		}
	}
	for (const source of sources) await source.remove();
	store.markMigrationDone();
	return {
		state: "migrated",
		copiedChunks: chunks.length,
		skippedChunks: skipped,
		floor: await store.readFloor(),
	};
}

async function verifiedChunks(
	snapshots: ReadonlyArray<LegacySnapshot>,
): Promise<{ readonly chunks: VerifiedChunk[]; readonly skipped: number }> {
	const chunks = new Map<string, VerifiedChunk>();
	let skipped = 0;
	for (const { hash, body } of snapshots.flatMap((item) => item.chunks)) {
		if (chunks.has(hash)) continue;
		const size = await verifiedSize(hash, body);
		if (size === null) skipped += 1;
		else chunks.set(hash, { hash, size, body });
	}
	return { chunks: [...chunks.values()], skipped };
}

/** The plaintext size of a legacy chunk that verifies, else null. The 0.2.x
 * files carry no size, so it comes from the zstd frame and is then proven by
 * decompressing to exactly that size and matching the content address. */
async function verifiedSize(
	hash: string,
	body: Uint8Array,
): Promise<number | null> {
	if (!SHA256.test(hash)) return null;
	const size = declaredContentSize(body);
	if (size === null || size > MAX_DECOMPRESSED_CHUNK_BYTES) return null;
	try {
		await decompressAndVerify(hash, body, size);
		return size;
	} catch {
		return null;
	}
}

async function verifiedManifests(
	snapshots: ReadonlyArray<LegacySnapshot>,
): Promise<Array<{ readonly hash: string; readonly body: Uint8Array }>> {
	const out = [];
	for (const manifest of snapshots.flatMap((item) => item.manifests)) {
		if ((await sha256Hex(manifest.body)) === manifest.hash) out.push(manifest);
	}
	return out;
}
