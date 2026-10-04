import type { MemoryTier } from "../sqlite/memoryProfile.js";
import { type SqlDatabaseOptions, type SqlStorage } from "./types.js";
/** The slice of the Web Locks API this module uses. */
export interface SqlLocks {
    request<T>(name: string, options: {
        readonly mode?: "exclusive";
        readonly signal?: AbortSignal;
        readonly ifAvailable?: boolean;
    }, callback: (lock: unknown) => Promise<T>): Promise<T>;
    /** Web Locks snapshot; used to confirm a live owner after a timed-out wait. */
    query?(): Promise<{
        readonly held?: ReadonlyArray<{
            readonly name?: string;
        }>;
    }>;
}
/**
 * How long to wait for a pool's previous owner to let go. close() now hands
 * the lock back within milliseconds, so what the wait really covers is a page
 * reload overlapping its predecessor while the browser tears that page's
 * Worker down — slowest on the weakest devices, so the budget scales with the
 * memory tier rather than being one fixed number.
 */
export declare function ownerLockWaitMs(tier: MemoryTier): number;
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
export interface OpenSqlStorageContext {
    /**
     * A bounded operation (an import, export or migration by name), not a
     * connection: it also holds `${pool}-operation`, so a context that times
     * out waiting for the owner lock knows to wait for it to finish.
     */
    readonly transient?: boolean;
}
export declare function openSqlStorage<R>(deps: SqlStorageDeps<R>, options: SqlDatabaseOptions, { transient }?: OpenSqlStorageContext): Promise<OpenedSqlStorage<R>>;
/** Held, alongside the owner lock, by a bounded operation on `pool`. */
export declare function poolOperationLock(pool: string): string;
/** The Web Lock every owner of the opfs-sahpool `pool` holds while open. */
export declare function poolOwnerLock(pool: string): string;
/**
 * Hold an exclusive lock until the returned release() is called; undefined if
 * it stayed taken for `waitMs` (Infinity: wait as long as it takes). release() resolves once the lock manager has
 * actually let go (the request's promise settles after the release), which is
 * what lets close() promise "the next owner can have it now".
 */
export declare function acquirePoolLease(locks: SqlLocks | undefined, name: string, waitMs: number): Promise<(() => Promise<void>) | undefined>;
/** DOMException is not an Error subclass in every realm, so match by name. */
export declare function isLockTimeout(error: unknown): boolean;
export declare function isPoolContentionError(error: unknown): boolean;
export declare function stableIdentity(name: string): Promise<string>;
//# sourceMappingURL=open.d.ts.map