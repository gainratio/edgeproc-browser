import { type SqlLocks } from "../../sql/open.js";
/** The slice of an installed opfs-sahpool the lifecycle needs. */
export interface PausablePool {
    /** Close every sync access handle the pool holds (no data loss). */
    pauseVfs(): unknown;
}
export interface OwnedPool<P extends PausablePool> {
    readonly pool: P;
    /** Close the pool's handles, then free the owner lock; resolves once free. */
    release(): Promise<void>;
}
/**
 * Take `poolName`'s owner lock (waiting up to `waitMs` for a previous owner),
 * then install the pool. Another live owner is a typed "pool-in-use" refusal.
 */
export declare function ownPool<P extends PausablePool>(locks: SqlLocks | undefined, poolName: string, waitMs: number, install: () => Promise<P>): Promise<OwnedPool<P>>;
/**
 * Close the index, then free its pool. Resolves only once the handles are
 * closed and the owner lock is free, so a caller that awaits dispose() can
 * remove or reopen the pool at once.
 */
export declare function disposeOwned(index: {
    dispose(): Promise<void> | void;
}, release: () => Promise<void>): Promise<void>;
//# sourceMappingURL=poolOwner.d.ts.map