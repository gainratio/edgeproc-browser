// In-memory CacheStore (Map-backed) implementing the same surface as the OPFS
// store, so the sync state machine is testable without OPFS (per the spec's
// "thin in-memory CacheStore" for pure-logic tests).
import { samePointer } from "./activePointer.js";
import { sha256Hex } from "./crypto.js";
import { decompressAndVerify, verifyPlaintext } from "./integrity.js";
export class MemoryCacheStore {
    // Chunks are stored as verified plaintext: ingest decompresses + verifies
    // once, reads re-verify the content-address invariant.
    #chunks = new Map();
    #manifests = new Map();
    #active = null;
    #trustRoot = null;
    hasChunk(chunkHash) {
        return Promise.resolve(this.#chunks.has(chunkHash));
    }
    async putChunkCompressed(chunkHash, compressed, expectedSize) {
        const plaintext = await decompressAndVerify(chunkHash, compressed, expectedSize);
        this.#chunks.set(chunkHash, plaintext);
    }
    async getChunk(chunkHash, expectedSize) {
        const plaintext = this.#chunks.get(chunkHash);
        if (plaintext === undefined) {
            throw new Error(`chunk ${chunkHash} not in store`);
        }
        if (plaintext.byteLength !== expectedSize) {
            throw new Error(`chunk ${chunkHash} has ${plaintext.byteLength} bytes, expected ${expectedSize}`);
        }
        await verifyPlaintext(chunkHash, plaintext);
        return plaintext;
    }
    async putManifest(manifestBytes) {
        const manifestHash = await sha256Hex(manifestBytes);
        this.#manifests.set(manifestHash, manifestBytes);
        return manifestHash;
    }
    getManifest(manifestHash) {
        const raw = this.#manifests.get(manifestHash);
        if (raw === undefined) {
            throw new Error(`manifest ${manifestHash} not in store`);
        }
        return Promise.resolve(raw);
    }
    readActive() {
        return Promise.resolve(this.#active);
    }
    promote(pointer) {
        this.#active = pointer;
        return Promise.resolve();
    }
    clearActiveIf(expected) {
        if (!samePointer(this.#active, expected))
            return Promise.resolve(false);
        this.#active = null;
        return Promise.resolve(true);
    }
    readTrustRoot() {
        return Promise.resolve(this.#trustRoot?.slice() ?? null);
    }
    putTrustRoot(bytes) {
        this.#trustRoot = bytes.slice();
        return Promise.resolve();
    }
    pruneInactive() {
        return Promise.resolve();
    }
    clear() {
        this.#chunks.clear();
        this.#manifests.clear();
        this.#active = null;
        this.#trustRoot = null;
        return Promise.resolve();
    }
}
//# sourceMappingURL=memoryStore.js.map