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
    /**
     * Free the pool's handles and owner lock. Call after closing the
     * connection; it resolves once the lock is actually free, so a removal or
     * reopen that follows never sees this context as the owner.
     */
    release(): Promise<void>;
}
export declare const SQL_POOL_PREFIX = "edgeproc-sql-";
/** The opfs-sahpool VFS name a database name maps to (OPFS dir: `.${pool}`). */
export declare function sqlDatabasePoolName(name: string): Promise<string>;
export declare function openSqlStorage<R>(deps: SqlStorageDeps<R>, options: SqlDatabaseOptions): Promise<OpenedSqlStorage<R>>;
/** The Web Lock every owner of the opfs-sahpool `pool` holds while open. */
export declare function poolOwnerLock(pool: string): string;
/**
 * Hold an exclusive lock until the returned release() is called; undefined if
 * it stayed taken for `waitMs`. release() resolves once the lock manager has
 * actually let go (the request's promise settles after the release), which is
 * what lets close() promise "the next owner can have it now".
 */
export declare function acquirePoolLease(locks: SqlLocks | undefined, name: string, waitMs: number): Promise<(() => Promise<void>) | undefined>;
/** DOMException is not an Error subclass in every realm, so match by name. */
export declare function isLockTimeout(error: unknown): boolean;
export declare function stableIdentity(name: string): Promise<string>;
//# sourceMappingURL=open.d.ts.map