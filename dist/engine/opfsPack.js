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
function isBoundedInteger(value, minimum, maximum) {
    return (Number.isSafeInteger(value) &&
        value >= minimum &&
        value <= maximum);
}
/** Parse an index against its data file's size; null when it is not sound. */
function parseIndex(raw, pack, dataSize, maxChunkBytes) {
    let parsed;
    try {
        parsed = JSON.parse(DECODER.decode(raw));
    }
    catch {
        return null;
    }
    const index = parsed;
    if (index?.v !== INDEX_VERSION || !Array.isArray(index.chunks))
        return null;
    const slots = [];
    for (const entry of index.chunks) {
        if (!Array.isArray(entry) || entry.length !== 3)
            return null;
        const [hash, offset, length] = entry;
        if (typeof hash !== "string" || !SHA256.test(hash))
            return null;
        if (!isBoundedInteger(length, 1, maxChunkBytes))
            return null;
        if (!isBoundedInteger(offset, 0, dataSize - length)) {
            return null;
        }
        slots.push([
            hash,
            { pack, offset: offset, length: length },
        ]);
    }
    return slots;
}
async function removeQuietly(dir, name) {
    try {
        await dir.removeEntry(name);
    }
    catch {
        // Already gone: nothing to remove.
    }
}
/** Write `parts` back to back into a fresh file: one handle, one flush. */
async function writeWhole(dir, name, parts) {
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
    }
    finally {
        handle.close();
    }
}
export class OpfsPacks {
    #dir;
    #maxChunkBytes;
    #slots = new Map();
    #snapshots = new Map();
    #loaded = null;
    constructor(dir, maxChunkBytes) {
        this.#dir = dir;
        this.#maxChunkBytes = maxChunkBytes;
    }
    async has(hash) {
        await this.#load();
        return this.#slots.has(hash);
    }
    /** The stored bytes of `hash`, or null when no pack holds it. */
    async read(hash) {
        await this.#load();
        const slot = this.#slots.get(hash);
        if (slot === undefined)
            return null;
        const end = slot.offset + slot.length;
        try {
            const snapshot = await this.#snapshot(slot.pack, false);
            return new Uint8Array(await snapshot.slice(slot.offset, end).arrayBuffer());
        }
        catch {
            // A snapshot goes stale if the file changed underneath it: re-open once.
            const snapshot = await this.#snapshot(slot.pack, true);
            return new Uint8Array(await snapshot.slice(slot.offset, end).arrayBuffer());
        }
    }
    /** Land a batch: data file, then index. On failure neither remains. */
    async write(chunks) {
        if (chunks.length === 0)
            return;
        await this.#load();
        const pack = crypto.randomUUID();
        const entries = [];
        let offset = 0;
        for (const chunk of chunks) {
            entries.push([chunk.hash, offset, chunk.compressed.byteLength]);
            offset += chunk.compressed.byteLength;
        }
        try {
            await writeWhole(this.#dir, pack, chunks.map((chunk) => chunk.compressed));
            await this.#writeIndex(pack, entries);
        }
        catch (error) {
            await this.#removePack(pack);
            throw translateStorageError(error);
        }
        for (const [hash, at, length] of entries) {
            this.#slots.set(hash, { pack, offset: at, length });
        }
    }
    /** Forget one chunk durably (its index is rewritten without it). */
    async evict(hash) {
        const slot = this.#slots.get(hash);
        if (slot === undefined)
            return;
        this.#slots.delete(hash);
        try {
            await this.#rewriteIndex(slot.pack);
        }
        catch {
            // Best effort: a stale index entry still fails closed on read.
        }
    }
    /** Keep only `live` chunks. Dead packs go; mostly-dead ones are compacted. */
    async retain(live) {
        await this.#load();
        for (const [pack, slots] of this.#byPack()) {
            const kept = slots.filter(([hash]) => live.has(hash));
            if (kept.length === slots.length)
                continue;
            const total = slots.reduce((sum, [, slot]) => sum + slot.length, 0);
            const liveBytes = kept.reduce((sum, [, slot]) => sum + slot.length, 0);
            for (const [hash] of slots) {
                if (!live.has(hash))
                    this.#slots.delete(hash);
            }
            if (kept.length > 0 && liveBytes >= total * COMPACT_BELOW_LIVE_RATIO) {
                await this.#rewriteIndex(pack);
                continue;
            }
            const survivors = [];
            for (const [hash] of kept) {
                const compressed = await this.read(hash);
                if (compressed !== null)
                    survivors.push({ hash, compressed });
            }
            await this.write(survivors);
            await this.#removePack(pack);
        }
        await this.#removeOrphans();
    }
    async clear() {
        this.#slots.clear();
        this.#snapshots.clear();
        const names = [];
        for await (const [name] of this.#dir.entries())
            names.push(name);
        await Promise.all(names.map((name) => removeQuietly(this.#dir, name)));
    }
    #load() {
        this.#loaded ??= this.#scan();
        return this.#loaded;
    }
    async #scan() {
        const indexes = [];
        for await (const [name] of this.#dir.entries()) {
            if (name.endsWith(INDEX_SUFFIX))
                indexes.push(name);
        }
        await Promise.all(indexes.map((name) => this.#loadPack(name.slice(0, -INDEX_SUFFIX.length))));
    }
    async #loadPack(pack) {
        let slots = null;
        try {
            const raw = await this.#dir.getFileHandle(`${pack}${INDEX_SUFFIX}`);
            const indexBytes = new Uint8Array(await (await raw.getFile()).arrayBuffer());
            const data = await this.#snapshot(pack, true);
            slots = parseIndex(indexBytes, pack, data.size, this.#maxChunkBytes);
        }
        catch {
            slots = null;
        }
        if (slots === null) {
            await this.#removePack(pack);
            return;
        }
        for (const [hash, slot] of slots)
            this.#slots.set(hash, slot);
    }
    async #snapshot(pack, refresh) {
        const cached = this.#snapshots.get(pack);
        if (cached !== undefined && !refresh)
            return cached;
        const file = await (await this.#dir.getFileHandle(pack)).getFile();
        this.#snapshots.set(pack, file);
        return file;
    }
    #byPack() {
        const packs = new Map();
        for (const entry of this.#slots) {
            const list = packs.get(entry[1].pack) ?? [];
            list.push(entry);
            packs.set(entry[1].pack, list);
        }
        return packs;
    }
    async #rewriteIndex(pack) {
        const entries = (this.#byPack().get(pack) ?? []).map(([hash, slot]) => [hash, slot.offset, slot.length]);
        if (entries.length === 0) {
            await this.#removePack(pack);
            return;
        }
        await this.#writeIndex(pack, entries);
    }
    async #writeIndex(pack, entries) {
        const body = ENCODER.encode(JSON.stringify({ v: INDEX_VERSION, chunks: entries }));
        await writeWhole(this.#dir, `${pack}${INDEX_SUFFIX}`, [body]);
    }
    async #removePack(pack) {
        this.#snapshots.delete(pack);
        for (const [hash, slot] of this.#slots) {
            if (slot.pack === pack)
                this.#slots.delete(hash);
        }
        await removeQuietly(this.#dir, `${pack}${INDEX_SUFFIX}`);
        await removeQuietly(this.#dir, pack);
    }
    /** Data files with no index: a write that never finished. */
    async #removeOrphans() {
        const known = new Set();
        for (const slot of this.#slots.values()) {
            known.add(slot.pack);
            known.add(`${slot.pack}${INDEX_SUFFIX}`);
        }
        const orphans = [];
        for await (const [name] of this.#dir.entries()) {
            if (!known.has(name))
                orphans.push(name);
        }
        await Promise.all(orphans.map((name) => removeQuietly(this.#dir, name)));
    }
}
//# sourceMappingURL=opfsPack.js.map