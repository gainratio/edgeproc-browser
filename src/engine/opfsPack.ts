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
//
// Several tabs (Workers) share this directory. Each keeps an in-memory index
// and rescans the directory on a miss and before pruning, so packs another
// tab wrote or removed are seen. A writer holds the PACK_LOCK Web Lock in
// shared mode from its data file to its index; unindexed or torn files are
// deleted only by a sweep that gets PACK_LOCK exclusively (never waiting for
// it), so no tab deletes another tab's half-written pack. Without the Web
// Locks API nothing unindexed is ever deleted.

import { translateStorageError } from "./storageError.js";

export const PACK_DIR = "pack";
/** Web Lock held shared by pack writers and exclusively by the orphan sweep. */
export const PACK_LOCK = "edgeproc-opfs-packs";
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

async function exists(
	dir: FileSystemDirectoryHandle,
	name: string,
): Promise<boolean> {
	try {
		await dir.getFileHandle(name);
		return true;
	} catch {
		return false;
	}
}

/** Run `operation` under PACK_LOCK in `mode`; without Web Locks, unlocked. */
function withPackLock<T>(
	mode: LockMode,
	operation: () => Promise<T>,
): Promise<T> {
	const locks = globalThis.navigator?.locks;
	if (locks === undefined) return operation();
	return locks.request(PACK_LOCK, { mode }, operation);
}

/** Run `operation` only if PACK_LOCK is free right now; false if it is not
 * (or the browser has no Web Locks, where sweeping is never safe). */
async function whenNoWriter(operation: () => Promise<void>): Promise<boolean> {
	const locks = globalThis.navigator?.locks;
	if (locks === undefined) return false;
	return locks.request(
		PACK_LOCK,
		{ mode: "exclusive", ifAvailable: true },
		async (lock) => {
			if (lock === null) return false;
			await operation();
			return true;
		},
	);
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

/** Write `parts` back to back into `name`: one handle, one flush. With
 * `create: false` a file another tab already removed is not recreated. */
async function writeWhole(
	dir: FileSystemDirectoryHandle,
	name: string,
	parts: ReadonlyArray<Uint8Array>,
	create = true,
): Promise<void> {
	const file = await dir.getFileHandle(name, { create });
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
	/** Packs whose index this instance has loaded (or written). */
	readonly #packs = new Set<string>();
	#scanning: Promise<void> | null = null;
	#scanned = false;

	public constructor(dir: FileSystemDirectoryHandle, maxChunkBytes: number) {
		this.#dir = dir;
		this.#maxChunkBytes = maxChunkBytes;
	}

	public async has(hash: string): Promise<boolean> {
		return (await this.#find(hash)) !== undefined;
	}

	/** The stored bytes of `hash`, or null when no pack holds it. */
	public async read(hash: string): Promise<Uint8Array | null> {
		const slot = await this.#find(hash);
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

	/** Land a batch: data file, then index, under the shared pack lock. On
	 * failure neither remains. */
	public async write(chunks: ReadonlyArray<PackedChunk>): Promise<void> {
		if (chunks.length === 0) return;
		const pack = crypto.randomUUID();
		const entries: Array<[string, number, number]> = [];
		let offset = 0;
		for (const chunk of chunks) {
			entries.push([chunk.hash, offset, chunk.compressed.byteLength]);
			offset += chunk.compressed.byteLength;
		}
		await withPackLock("shared", async () => {
			try {
				await writeWhole(
					this.#dir,
					pack,
					chunks.map((chunk) => chunk.compressed),
				);
				await this.#writeIndex(pack, entries, true);
			} catch (error) {
				await this.#removePack(pack);
				throw translateStorageError(error);
			}
		});
		this.#packs.add(pack);
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

	/** Keep only `live` chunks. Dead packs go; mostly-dead ones are compacted;
	 * then unindexed leftovers are swept if no tab is writing a pack. */
	public async retain(live: ReadonlySet<string>): Promise<void> {
		await this.#rescan();
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
		await whenNoWriter(() => this.#sweep());
	}

	public async clear(): Promise<void> {
		this.#slots.clear();
		this.#snapshots.clear();
		this.#packs.clear();
		const names: string[] = [];
		for await (const [name] of this.#dir.entries()) names.push(name);
		await Promise.all(names.map((name) => removeQuietly(this.#dir, name)));
	}

	/** The slot for `hash`, rescanning the directory once on a miss. */
	async #find(hash: string): Promise<Slot | undefined> {
		if (!this.#scanned) await this.#rescan();
		const slot = this.#slots.get(hash);
		if (slot !== undefined) return slot;
		await this.#rescan();
		return this.#slots.get(hash);
	}

	/** Load packs other tabs added and forget packs they removed. Concurrent
	 * callers share one scan. */
	#rescan(): Promise<void> {
		this.#scanning ??= this.#scan().finally(() => {
			this.#scanning = null;
			this.#scanned = true;
		});
		return this.#scanning;
	}

	async #scan(): Promise<void> {
		const listed = new Set<string>();
		for await (const [name] of this.#dir.entries()) {
			if (name.endsWith(INDEX_SUFFIX)) {
				listed.add(name.slice(0, -INDEX_SUFFIX.length));
			}
		}
		for (const pack of this.#packs) {
			if (!listed.has(pack)) this.#forget(pack);
		}
		const fresh = [...listed].filter((pack) => !this.#packs.has(pack));
		const torn = await Promise.all(fresh.map((pack) => this.#loadPack(pack)));
		if (torn.some(Boolean)) await whenNoWriter(() => this.#sweep());
	}

	/** Load one pack's index; true when it is unreadable or unsound. */
	async #loadPack(pack: string): Promise<boolean> {
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
		if (slots === null) return true;
		this.#packs.add(pack);
		for (const [hash, slot] of slots) this.#slots.set(hash, slot);
		return false;
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

	/** Rewrite a pack's index from memory. A pack whose data file is gone, or
	 * whose index another tab removed, is forgotten and never recreated. */
	async #rewriteIndex(pack: string): Promise<void> {
		const entries = (this.#byPack().get(pack) ?? []).map(
			([hash, slot]) => [hash, slot.offset, slot.length] as const,
		);
		if (entries.length === 0 || !(await exists(this.#dir, pack))) {
			await this.#removePack(pack);
			return;
		}
		await this.#writeIndex(pack, entries, false);
	}

	async #writeIndex(
		pack: string,
		entries: ReadonlyArray<readonly [string, number, number]>,
		create: boolean,
	): Promise<void> {
		const body = ENCODER.encode(
			JSON.stringify({ v: INDEX_VERSION, chunks: entries }),
		);
		await writeWhole(this.#dir, `${pack}${INDEX_SUFFIX}`, [body], create);
	}

	#forget(pack: string): void {
		this.#packs.delete(pack);
		this.#snapshots.delete(pack);
		for (const [hash, slot] of this.#slots) {
			if (slot.pack === pack) this.#slots.delete(hash);
		}
	}

	async #removePack(pack: string): Promise<void> {
		this.#forget(pack);
		await removeQuietly(this.#dir, `${pack}${INDEX_SUFFIX}`);
		await removeQuietly(this.#dir, pack);
	}

	/** Under an exclusive PACK_LOCK (no tab mid-write): delete every file that
	 * is not part of a sound, loaded pack. Rescans first so packs other tabs
	 * finished are loaded, not deleted. */
	async #sweep(): Promise<void> {
		const names: string[] = [];
		for await (const [name] of this.#dir.entries()) names.push(name);
		const indexes = names.filter((name) => name.endsWith(INDEX_SUFFIX));
		for (const index of indexes) {
			const pack = index.slice(0, -INDEX_SUFFIX.length);
			if (!this.#packs.has(pack)) await this.#loadPack(pack);
		}
		const keep = new Set<string>();
		for (const pack of this.#packs) {
			keep.add(pack);
			keep.add(`${pack}${INDEX_SUFFIX}`);
		}
		const stray = names.filter((name) => !keep.has(name));
		await Promise.all(stray.map((name) => removeQuietly(this.#dir, name)));
	}
}
