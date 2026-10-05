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
// Fallback: if OPFS is refused (Playwright's WebKit, private browsing), this
// Worker switches to ONE in-memory database for the rest of its life, reports
// it in a typed SqlStorage status, re-downloads each session, and enforces the
// 0.2.x IndexedDB floor if one exists (read-only). It never writes IndexedDB.
// A pool held by a foreign context fails the operation closed instead: an
// empty in-memory floor next to a persisted one could accept a rollback.
import { SqlEngine } from "../sql/engine.js";
import { opfsPoolExists } from "../sql/legacy.js";
import { sqlDatabasePoolName } from "../sql/open.js";
import { SqlStorageUnavailableError } from "../sql/types.js";
import { validatedNamespace } from "./cacheLock.js";
import { importLegacyFloor, LegacyFloorUnavailableError, migrateLegacyStores, } from "./migration.js";
import { SqliteCacheStore } from "./sqliteStore.js";
/** The SQL database a cache namespace's chunks live in. */
export function chunkDatabaseName(namespace) {
    return `${validatedNamespace(namespace)}-chunks`;
}
/** Whether `name`'s opfs-sahpool directory exists. A refused OPFS root is
 * "no" (nothing can have been persisted through it, the same rule the 0.2.x
 * reader uses); any other error propagates, so the caller fails closed. */
export async function persistedSqlPoolExists(name, openRoot) {
    let root;
    try {
        root = await openRoot();
    }
    catch {
        return false;
    }
    return opfsPoolExists(await sqlDatabasePoolName(name), root);
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
                reset: options.reset === true,
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
                await Promise.all(batch.map((queued) => this.#runOne(session, queued)));
            }
        }
        finally {
            await session.close();
        }
    }
    async #runOne(session, queued) {
        const { operation, resolve, reject, reset } = queued;
        if (session.floorRefusal !== null && !reset) {
            reject(session.floorRefusal);
            return;
        }
        try {
            const value = await withFlush(session.store, () => operation(session.store, session.storage));
            if (reset) {
                for (const source of this.#options.legacySources()) {
                    await source.remove();
                }
            }
            resolve(value);
        }
        catch (error) {
            reject(error);
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
        const name = chunkDatabaseName(this.#options.namespace);
        const opened = await this.#options.open(name);
        if (opened.storage.persistence === "memory") {
            await opened.release();
            if (opened.storage.reason === "pool-in-use") {
                // A persisted floor exists in a file we cannot open right now. An
                // empty in-memory floor beside it could accept a rollback: refuse.
                opened.raw.close();
                throw new SqlStorageUnavailableError("pool-in-use", `chunk database is held by another context (${opened.storage.detail ?? "pool-in-use"}); retry`);
            }
            await this.#refuseBesidePersistedFloor(name, opened.raw, opened.storage.detail ?? opened.storage.reason);
            const engine = this.#engine(opened.raw, opened.storage);
            const memory = {
                engine,
                storage: opened.storage,
                floorRefusal: await this.#legacyFloorInto(SqliteCacheStore.open(engine)),
            };
            this.#memory = memory.floorRefusal === null ? memory : null;
            return this.#memorySession(memory);
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
            const floorRefusal = await this.#migrateOnce(store);
            return { store, storage: opened.storage, floorRefusal, close };
        }
        catch (error) {
            await close();
            throw error;
        }
    }
    /** OPFS failed for another reason. If this database's pool is on disk,
     * its floor is too: an empty in-memory floor beside it could accept a
     * rollback, so refuse (an error deciding that refuses as well). */
    async #refuseBesidePersistedFloor(name, raw, detail) {
        let exists = true;
        try {
            exists = await this.#options.persistedPoolExists(name);
        }
        finally {
            if (exists)
                raw.close();
        }
        if (exists) {
            throw new SqlStorageUnavailableError("opfs-unavailable", `chunk database exists on disk but could not be opened (${detail}); refusing to run without its rollback floor`);
        }
    }
    /** Memory mode (OPFS refused): no SQLite floor can persist, so the 0.2.x
     * IndexedDB floor, if any, is read (never written, never deleted) and
     * enforced for this Worker's life. */
    async #legacyFloorInto(store) {
        try {
            await importLegacyFloor(store, this.#options.legacySources());
            return null;
        }
        catch (error) {
            if (error instanceof LegacyFloorUnavailableError)
                return error;
            throw error;
        }
    }
    #memorySession(memory) {
        return {
            store: SqliteCacheStore.open(memory.engine),
            storage: memory.storage,
            floorRefusal: memory.floorRefusal ?? null,
            close: async () => undefined,
        };
    }
    #engine(raw, storage) {
        return new SqlEngine(raw, {
            storage,
            memoryProfile: this.#options.memoryProfile,
        });
    }
    /** A failed BULK copy never blocks the operation: the legacy floor was
     * imported first, the sync re-downloads, nothing legacy is deleted, and
     * the next session tries again. An unreadable FLOOR blocks everything but
     * an explicit reset (returned as the session's refusal). */
    async #migrateOnce(store) {
        if (this.#migrated)
            return null;
        try {
            await migrateLegacyStores(store, this.#options.legacySources());
            this.#migrated = true;
        }
        catch (error) {
            if (error instanceof LegacyFloorUnavailableError)
                return error;
            this.#options.warn(`legacy cache migration did not complete (${error instanceof Error ? error.message : String(error)}); re-downloading`);
        }
        return null;
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