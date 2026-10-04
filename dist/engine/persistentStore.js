import { samePointer } from "./activePointer.js";
import { cacheDatabaseName, validatedNamespace } from "./cacheLock.js";
import { IndexedDbCacheStore, resolveIndexedDbLayout, } from "./indexedDbStore.js";
import { IntegrityError } from "./integrity.js";
import { OpfsCacheStore, selectHighestPointer } from "./opfsStore.js";
import { StorageQuotaError } from "./storageError.js";
export function requestPersistentStorage(storage) {
    void storage?.persist?.().catch(() => false);
}
export async function openPersistentCacheStore(options = {}) {
    const namespace = validatedNamespace(options.namespace ?? "edgeproc-browser");
    const indexedDbLayout = resolveIndexedDbLayout(options.indexedDbLayout, cacheDatabaseName(namespace));
    const openers = options.openers ?? {
        // Keep the historical origin-root OPFS layout for upgrade compatibility.
        // The namespace scopes the Web Lock and IndexedDB rollback floor.
        openOpfs: () => OpfsCacheStore.open(),
        openIndexedDb: () => IndexedDbCacheStore.open(indexedDbLayout),
    };
    let indexedDb;
    try {
        indexedDb = await openers.openIndexedDb();
    }
    catch (error) {
        throw new Error("persistent rollback floor unavailable", { cause: error });
    }
    if (options.storageBackend === "indexeddb")
        return indexedDb;
    try {
        return new CoordinatedCacheStore(await openers.openOpfs(), indexedDb);
    }
    catch {
        return indexedDb;
    }
}
class CoordinatedCacheStore {
    cacheBackend = "opfs+indexeddb";
    #primary;
    #floor;
    constructor(primary, floor) {
        this.#primary = primary;
        this.#floor = floor;
    }
    async hasChunk(hash) {
        const [primary, floor] = await Promise.all([
            this.#primary.hasChunk(hash),
            this.#floor.hasChunk(hash),
        ]);
        return primary || floor;
    }
    async putChunkCompressed(hash, compressed, expectedSize) {
        await this.#retryQuota(() => this.#primary.putChunkCompressed(hash, compressed, expectedSize));
    }
    /** Batches go to the primary only, like single chunks; a primary without
     * batch support gets one put per chunk. */
    async putChunksCompressed(chunks) {
        const primary = this.#primary;
        const putBatch = primary.putChunksCompressed;
        await this.#retryQuota(async () => {
            if (putBatch !== undefined) {
                await putBatch.call(primary, chunks);
                return;
            }
            for (const chunk of chunks) {
                await primary.putChunkCompressed(chunk.hash, chunk.compressed, chunk.size);
            }
        });
    }
    async getChunk(hash, expectedSize) {
        try {
            return await this.#primary.getChunk(hash, expectedSize);
        }
        catch {
            return this.#floor.getChunk(hash, expectedSize);
        }
    }
    async putManifest(bytes) {
        return this.#retryQuota(() => this.#primary.putManifest(bytes));
    }
    async getManifest(hash) {
        try {
            return await this.#primary.getManifest(hash);
        }
        catch {
            return this.#floor.getManifest(hash);
        }
    }
    async readActive() {
        const [primary, floor] = await Promise.all([
            this.#primary.readActive(),
            this.#floor.readActive(),
        ]);
        if (primary !== null &&
            floor !== null &&
            primary.sequence === floor.sequence &&
            !samePointer(primary, floor)) {
            throw new IntegrityError("persistent cache rollback floors disagree");
        }
        return selectHighestPointer([primary, floor]);
    }
    async promote(pointer) {
        await this.#floor.promote(pointer);
        await this.#primary.promote(pointer);
    }
    async clearActiveIf(expected) {
        const [floor, primary] = await Promise.all([
            this.#floor.clearActiveIf(expected),
            this.#primary.clearActiveIf(expected),
        ]);
        return floor || primary;
    }
    async pruneInactive() {
        await Promise.all([
            this.#floor.pruneInactive(),
            this.#primary.pruneInactive(),
        ]);
    }
    async clear() {
        await Promise.all([this.#floor.clear(), this.#primary.clear()]);
    }
    async #retryQuota(operation) {
        try {
            return await operation();
        }
        catch (error) {
            if (!(error instanceof StorageQuotaError))
                throw error;
            await this.#primary.pruneInactive();
            return operation();
        }
    }
}
//# sourceMappingURL=persistentStore.js.map