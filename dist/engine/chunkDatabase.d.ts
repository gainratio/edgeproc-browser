import { type SqlRawDatabase } from "../sql/engine.js";
import type { OpenedSqlStorage } from "../sql/open.js";
import type { SqlStorage } from "../sql/types.js";
import type { MemoryProfile } from "../sqlite/memoryProfile.js";
import { type LegacySource } from "./migration.js";
import { SqliteCacheStore } from "./sqliteStore.js";
/** The SQL database a cache namespace's chunks live in. */
export declare function chunkDatabaseName(namespace: string): string;
export interface ChunkDatabaseOptions {
    readonly namespace: string;
    /** openSqlStorage with `fallback: "memory"`, bound to the Worker's SQLite. */
    readonly open: (name: string) => Promise<OpenedSqlStorage<SqlRawDatabase>>;
    readonly memoryProfile: MemoryProfile;
    /** The 0.2.x stores to migrate from; only read in persistent mode. */
    readonly legacySources: () => ReadonlyArray<LegacySource>;
    readonly warn: (message: string) => void;
    /** The cross-tab cache lock (a Web Lock in the Worker). Default: none. */
    readonly withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}
export type ChunkOperation<T> = (store: SqliteCacheStore, storage: SqlStorage) => Promise<T>;
/** `shared`: read-only, so it may run alongside other shared operations
 * (each still a sequence of synchronous SQLite calls on one connection). */
export interface ChunkRunOptions {
    readonly shared?: boolean;
    /** The user's explicit cache reset: runs even when a legacy floor is
     * unreadable, and deletes the legacy stores after it. */
    readonly reset?: boolean;
}
/**
 * One session = the cross-tab cache lock, then the SQLite pool, held while
 * this Worker has queued operations (an app reading 25 files is one session,
 * not 25 opens), then both released. Another tab waits on the cache lock, not
 * on the pool, so it can never time out into the memory fallback because of
 * this tab.
 */
export declare class ChunkDatabase {
    #private;
    constructor(options: ChunkDatabaseOptions);
    run<T>(operation: ChunkOperation<T>, options?: ChunkRunOptions): Promise<T>;
    /** Resolves once no session is open (the locks are free). */
    idle(): Promise<void>;
}
//# sourceMappingURL=chunkDatabase.d.ts.map