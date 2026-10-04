// Pack files: many content-addressed chunks in ONE OPFS file.
//
// Why: an OPFS file costs a fixed set of storage round trips (getFileHandle,
// createSyncAccessHandle, close). Chromium pays ~0.4 ms; Firefox pays ~2.5 ms
// on macOS and ~10 ms on Linux, and does not overlap them. One file per ~2 KB
// chunk made a 783-chunk cold boot spend 2-10 s in file bookkeeping alone.
//
// Layout, under `pack/`:
//   <id>      verbatim zstd chunks, back to back
//   <id>.idx  {"v":1,"chunks":[[hash, offset, length], ...]}
// Each is written through one sync access handle with one flush, data first,
// so a chunk becomes visible only once its bytes are durable. A torn or
// inconsistent index drops the whole pack: its chunks read as absent and the
// next sync re-fetches them. Nothing here is trusted: the store re-verifies
// every chunk it reads (decompress -> SHA-256 -> compare).

import { translateStorageError } from "./storageError.js";

export const PACK_DIR = "pack";
const INDEX_SUFFIX = ".idx";
const INDEX_VERSION = 1;
const SHA256 = /^[0-9a-f]{64}$/u;
/** A pack keeps its file while at least this share of its bytes is live. */
const COMPACT_BELOW_LIVE_RATIO = 0.5;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

interface Slot {
	readonly pack: string;
	readonly offset: number;
	readonly length: number;
}

export interface PackedChunk {
	readonly hash: string;
	readonly compressed: Uint8Array;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number) {
	return (
		Number.isSafeInteger(value) &&
		(value as number) >= minimum &&
		(value as number) <= maximum
	);
}

/** Parse an index against its data file's size; null when it is not sound. */
function parseIndex(
	raw: Uint8Array,
	pack: string,
	dataSize: number,
	maxChunkBytes: number,
): ReadonlyArray<readonly [string, Slot]> | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(DECODER.decode(raw));
	} catch {
		return null;
	}
	const index = parsed as { v?: unknown; chunks?: unknown };
	if (index?.v !== INDEX_VERSION || !Array.isArray(index.chunks)) return null;
	const slots: Array<readonly [string, Slot]> = [];
	for (const entry of index.chunks as unknown[]) {
		if (!Array.isArray(entry) || entry.length !== 3) return null;
		const [hash, offset, length] = entry as [unknown, unknown, unknown];
		if (typeof hash !== "string" || !SHA256.test(hash)) return null;
		if (!isBoundedInteger(length, 1, maxChunkBytes)) return null;
		if (!isBoundedInteger(offset, 0, dataSize - (length as number))) {
			return null;
		}
		slots.push([
			hash,
			{ pack, offset: offset as number, length: length as number },
		]);
	}
	return slots;
}

async function removeQuietly(
	dir: FileSystemDirectoryHandle,
	name: string,
): Promise<void> {
	try {
		await dir.removeEntry(name);
	} catch {
		// Already gone: nothing to remove.
	}
}

/** Write `parts` back to back into a fresh file: one handle, one flush. */
async function writeWhole(
	dir: FileSystemDirectoryHandle,
	name: string,
	parts: ReadonlyArray<Uint8Array>,
): Promise<void> {
	const file = await dir.getFileHandle(name, { create: true });
	const handle = await file.createSyncAccessHandle();
	try {
		handle.truncate(0);
		let at = 0;
		for (const part of parts) {
			handle.write(part, { at });
			at += part.byteLength;
		}
		handle.flush();
	} finally {
		handle.close();
	}
}

export class OpfsPacks {
	readonly #dir: FileSystemDirectoryHandle;
	readonly #maxChunkBytes: number;
	readonly #slots = new Map<string, Slot>();
	readonly #snapshots = new Map<string, Blob>();
	#loaded: Promise<void> | null = null;

	public constructor(dir: FileSystemDirectoryHandle, maxChunkBytes: number) {
		this.#dir = dir;
		this.#maxChunkBytes = maxChunkBytes;
	}

	public async has(hash: string): Promise<boolean> {
		await this.#load();
		return this.#slots.has(hash);
	}

	/** The stored bytes of `hash`, or null when no pack holds it. */
	public async read(hash: string): Promise<Uint8Array | null> {
		await this.#load();
		const slot = this.#slots.get(hash);
		if (slot === undefined) return null;
		const end = slot.offset + slot.length;
		try {
			const snapshot = await this.#snapshot(slot.pack, false);
			return new Uint8Array(
				await snapshot.slice(slot.offset, end).arrayBuffer(),
			);
		} catch {
			// A snapshot goes stale if the file changed underneath it: re-open once.
			const snapshot = await this.#snapshot(slot.pack, true);
			return new Uint8Array(
				await snapshot.slice(slot.offset, end).arrayBuffer(),
			);
		}
	}

	/** Land a batch: data file, then index. On failure neither remains. */
	public async write(chunks: ReadonlyArray<PackedChunk>): Promise<void> {
		if (chunks.length === 0) return;
		await this.#load();
		const pack = crypto.randomUUID();
		const entries: Array<[string, number, number]> = [];
		let offset = 0;
		for (const chunk of chunks) {
			entries.push([chunk.hash, offset, chunk.compressed.byteLength]);
			offset += chunk.compressed.byteLength;
		}
		try {
			await writeWhole(
				this.#dir,
				pack,
				chunks.map((chunk) => chunk.compressed),
			);
			await this.#writeIndex(pack, entries);
		} catch (error) {
			await this.#removePack(pack);
			throw translateStorageError(error);
		}
		for (const [hash, at, length] of entries) {
			this.#slots.set(hash, { pack, offset: at, length });
		}
	}

	/** Forget one chunk durably (its index is rewritten without it). */
	public async evict(hash: string): Promise<void> {
		const slot = this.#slots.get(hash);
		if (slot === undefined) return;
		this.#slots.delete(hash);
		try {
			await this.#rewriteIndex(slot.pack);
		} catch {
			// Best effort: a stale index entry still fails closed on read.
		}
	}

	/** Keep only `live` chunks. Dead packs go; mostly-dead ones are compacted. */
	public async retain(live: ReadonlySet<string>): Promise<void> {
		await this.#load();
		for (const [pack, slots] of this.#byPack()) {
			const kept = slots.filter(([hash]) => live.has(hash));
			if (kept.length === slots.length) continue;
			const total = slots.reduce((sum, [, slot]) => sum + slot.length, 0);
			const liveBytes = kept.reduce((sum, [, slot]) => sum + slot.length, 0);
			for (const [hash] of slots) {
				if (!live.has(hash)) this.#slots.delete(hash);
			}
			if (kept.length > 0 && liveBytes >= total * COMPACT_BELOW_LIVE_RATIO) {
				await this.#rewriteIndex(pack);
				continue;
			}
			const survivors: PackedChunk[] = [];
			for (const [hash] of kept) {
				const compressed = await this.read(hash);
				if (compressed !== null) survivors.push({ hash, compressed });
			}
			await this.write(survivors);
			await this.#removePack(pack);
		}
		await this.#removeOrphans();
	}

	public async clear(): Promise<void> {
		this.#slots.clear();
		this.#snapshots.clear();
		const names: string[] = [];
		for await (const [name] of this.#dir.entries()) names.push(name);
		await Promise.all(names.map((name) => removeQuietly(this.#dir, name)));
	}

	#load(): Promise<void> {
		this.#loaded ??= this.#scan();
		return this.#loaded;
	}

	async #scan(): Promise<void> {
		const indexes: string[] = [];
		for await (const [name] of this.#dir.entries()) {
			if (name.endsWith(INDEX_SUFFIX)) indexes.push(name);
		}
		await Promise.all(
			indexes.map((name) =>
				this.#loadPack(name.slice(0, -INDEX_SUFFIX.length)),
			),
		);
	}

	async #loadPack(pack: string): Promise<void> {
		let slots: ReadonlyArray<readonly [string, Slot]> | null = null;
		try {
			const raw = await this.#dir.getFileHandle(`${pack}${INDEX_SUFFIX}`);
			const indexBytes = new Uint8Array(
				await (await raw.getFile()).arrayBuffer(),
			);
			const data = await this.#snapshot(pack, true);
			slots = parseIndex(indexBytes, pack, data.size, this.#maxChunkBytes);
		} catch {
			slots = null;
		}
		if (slots === null) {
			await this.#removePack(pack);
			return;
		}
		for (const [hash, slot] of slots) this.#slots.set(hash, slot);
	}

	async #snapshot(pack: string, refresh: boolean): Promise<Blob> {
		const cached = this.#snapshots.get(pack);
		if (cached !== undefined && !refresh) return cached;
		const file = await (await this.#dir.getFileHandle(pack)).getFile();
		this.#snapshots.set(pack, file);
		return file;
	}

	#byPack(): Map<string, Array<readonly [string, Slot]>> {
		const packs = new Map<string, Array<readonly [string, Slot]>>();
		for (const entry of this.#slots) {
			const list = packs.get(entry[1].pack) ?? [];
			list.push(entry);
			packs.set(entry[1].pack, list);
		}
		return packs;
	}

	async #rewriteIndex(pack: string): Promise<void> {
		const entries = (this.#byPack().get(pack) ?? []).map(
			([hash, slot]) => [hash, slot.offset, slot.length] as const,
		);
		if (entries.length === 0) {
			await this.#removePack(pack);
			return;
		}
		await this.#writeIndex(pack, entries);
	}

	async #writeIndex(
		pack: string,
		entries: ReadonlyArray<readonly [string, number, number]>,
	): Promise<void> {
		const body = ENCODER.encode(
			JSON.stringify({ v: INDEX_VERSION, chunks: entries }),
		);
		await writeWhole(this.#dir, `${pack}${INDEX_SUFFIX}`, [body]);
	}

	async #removePack(pack: string): Promise<void> {
		this.#snapshots.delete(pack);
		for (const [hash, slot] of this.#slots) {
			if (slot.pack === pack) this.#slots.delete(hash);
		}
		await removeQuietly(this.#dir, `${pack}${INDEX_SUFFIX}`);
		await removeQuietly(this.#dir, pack);
	}

	/** Data files with no index: a write that never finished. */
	async #removeOrphans(): Promise<void> {
		const known = new Set<string>();
		for (const slot of this.#slots.values()) {
			known.add(slot.pack);
			known.add(`${slot.pack}${INDEX_SUFFIX}`);
		}
		const orphans: string[] = [];
		for await (const [name] of this.#dir.entries()) {
			if (!known.has(name)) orphans.push(name);
		}
		await Promise.all(orphans.map((name) => removeQuietly(this.#dir, name)));
	}
}
