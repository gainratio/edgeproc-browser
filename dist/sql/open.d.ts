import { type SqlDatabaseOptions, type SqlStorage } from "./types.js";
/** The slice of the Web Locks API this module uses. */
export interface SqlLocks {
    request<T>(name: string, options: {
        readonly mode?: "exclusive";
        readonly signal?: AbortSignal;
        readonly ifAvailable?: boolean;
    }, callback: (lock: unknown) => Promise<T>): Promise<T>;
}
export interface SqlStorageDeps<R> {
    readonly openMemory: () => R;
    readonly installPool: (poolName: string) => Promise<{
        readonly OpfsSAHPoolDb: new (file: string) => R;
        /** opfs-sahpool: close the pool's sync access handles (no data loss). */
        pauseVfs?(): unknown;
    }>;
    readonly locks: SqlLocks | undefined;
    readonly warn: (message: string) => void;
    /** How long to wait for a previous owner before giving up. */
    readonly lockWaitMs: number;
}
export interface OpenedSqlStorage<R> {
    readonly raw: R;
    readonly storage: SqlStorage;
    /** Release the pool's owner lock. Call after closing the connection. */
    release(): void;
}
export declare const SQL_POOL_PREFIX = "edgeproc-sql-";
/** The opfs-sahpool VFS name a database name maps to (OPFS dir: `.${pool}`). */
export declare function sqlDatabasePoolName(name: string): Promise<string>;
export declare function openSqlStorage<R>(deps: SqlStorageDeps<R>, options: SqlDatabaseOptions): Promise<OpenedSqlStorage<R>>;
export declare function stableIdentity(name: string): Promise<string>;
//# sourceMappingURL=open.d.ts.map