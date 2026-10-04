// The engine Worker's SQLite chunk database, opened through the library's own
// SQL seam (SqlEngine + openSqlStorage: opfs-sahpool, the pool owner lock,
// the device memory profile, secure_delete).
//
// Cross-tab: the cache Web Lock and then the pool's owner lock are held for
// one SESSION (the operations this Worker has queued: a sync, a burst of
// reads) and released after it. Tabs take turns on the same persistent file
// instead of one tab owning it for its whole life, and every session opens a
// fresh connection, so it always sees the other tabs' commits.
//
// Fallback: if OPFS is refused (Playwright's WebKit, private browsing) or a
// foreign context holds the pool, this Worker switches to ONE in-memory
// database for the rest of its life, reports it in a typed SqlStorage status,
// and re-downloads each session. It never falls back to IndexedDB.
import { SqlEngine } from "../sql/engine.js";
import { validatedNamespace } from "./cacheLock.js";
import { migrateLegacyStores } from "./migration.js";
import { SqliteCacheStore } from "./sqliteStore.js";
/** The SQL database a cache namespace's chunks live in. */
export function chunkDatabaseName(namespace) {
    return `${validatedNamespace(namespace)}-chunks`;
}
/**
 * One session = the cross-tab cache lock, then the SQLite pool, held while
 * this Worker has queued operations (an app reading 25 files is one session,
 * not 25 opens), then both released. Another tab waits on the cache lock, not
 * on the pool, so it can never time out into the memory fallback because of
 * this tab.
 */
export class ChunkDatabase {
    #options;
    #queue = [];
    #draining = null;
    #memory = null;
    #migrated = false;
    constructor(options) {
        this.#options = options;
    }
    run(operation, options = {}) {
        return new Promise((resolve, reject) => {
            this.#queue.push({
                shared: options.shared === true,
                operation,
                resolve: resolve,
                reject,
            });
            this.#draining ??= this.#drain().finally(() => {
                this.#draining = null;
            });
        });
    }
    /** Resolves once no session is open (the locks are free). */
    idle() {
        return this.#draining ?? Promise.resolve();
    }
    async #drain() {
        const withLock = this.#options.withLock ?? ((work) => work());
        while (this.#queue.length > 0) {
            await withLock(() => this.#session()).catch((error) => {
                for (const queued of this.#queue.splice(0))
                    queued.reject(error);
            });
        }
    }
    async #session() {
        const session = await this.#open();
        try {
            for (let batch = this.#nextBatch(); batch.length > 0; batch = this.#nextBatch()) {
                await Promise.all(batch.map(({ operation, resolve, reject }) => withFlush(session.store, () => operation(session.store, session.storage)).then(resolve, reject)));
            }
        }
        finally {
            await session.close();
        }
    }
    /** The next exclusive operation alone, or every leading shared one. */
    #nextBatch() {
        const first = this.#queue[0];
        if (first === undefined)
            return [];
        if (!first.shared)
            return this.#queue.splice(0, 1);
        const end = this.#queue.findIndex((queued) => !queued.shared);
        return this.#queue.splice(0, end === -1 ? this.#queue.length : end);
    }
    async #open() {
        if (this.#memory !== null)
            return this.#memorySession(this.#memory);
        const opened = await this.#options.open(chunkDatabaseName(this.#options.namespace));
        if (opened.storage.persistence === "memory") {
            this.#memory = {
                engine: this.#engine(opened.raw, opened.storage),
                storage: opened.storage,
            };
            await opened.release();
            return this.#memorySession(this.#memory);
        }
        let engine;
        const close = async () => {
            try {
                if (engine === undefined)
                    opened.raw.close();
                else
                    engine.close();
            }
            finally {
                await opened.release();
            }
        };
        try {
            engine = this.#engine(opened.raw, opened.storage);
            const store = SqliteCacheStore.open(engine);
            await this.#migrateOnce(store);
            return { store, storage: opened.storage, close };
        }
        catch (error) {
            await close();
            throw error;
        }
    }
    #memorySession(memory) {
        return {
            store: SqliteCacheStore.open(memory.engine),
            storage: memory.storage,
            close: async () => undefined,
        };
    }
    #engine(raw, storage) {
        return new SqlEngine(raw, {
            storage,
            memoryProfile: this.#options.memoryProfile,
        });
    }
    /** A failed migration never blocks the operation: the sync re-downloads,
     * nothing legacy is deleted, and the next session tries again. */
    async #migrateOnce(store) {
        if (this.#migrated)
            return;
        try {
            await migrateLegacyStores(store, this.#options.legacySources());
            this.#migrated = true;
        }
        catch (error) {
            this.#options.warn(`legacy cache migration did not complete (${error instanceof Error ? error.message : String(error)}); re-downloading`);
        }
    }
}
/** Verified chunks still in the ingest buffer are committed even when the
 * operation fails, so an interrupted sync resumes instead of restarting. */
async function withFlush(store, operation) {
    try {
        return await operation();
    }
    finally {
        await store.flush();
    }
}
//# sourceMappingURL=chunkDatabase.js.map