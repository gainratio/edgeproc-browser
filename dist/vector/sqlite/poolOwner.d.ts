import { type SqlLocks } from "../../sql/open.js";
import { type SahPoolSlots } from "../../sql/sahPool.js";
import type { TempStore } from "../../sqlite/memoryProfile.js";
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
/** A pool that can open its database file and count its slots. */
export interface DatabasePool<R> extends PausablePool, SahPoolSlots {
    readonly OpfsSAHPoolDb: new (file: string) => R;
}
/**
 * Own `poolName` (ownPool), top its slots up to what its database file
 * `/${poolName}.sqlite3` needs for `tempStore`, then open that file.
 */
export declare function openOwnedDatabase<P extends DatabasePool<unknown>>(locks: SqlLocks | undefined, poolName: string, waitMs: number, tempStore: TempStore, install: () => Promise<P>): Promise<{
    readonly raw: InstanceType<P["OpfsSAHPoolDb"]>;
    readonly release: () => Promise<void>;
}>;
/**
 * Close the index, then free its pool. Resolves only once the handles are
 * closed and the owner lock is free, so a caller that awaits dispose() can
 * remove or reopen the pool at once.
 */
export declare function disposeOwned(index: {
    dispose(): Promise<void> | void;
}, release: () => Promise<void>): Promise<void>;
//# sourceMappingURL=poolOwner.d.ts.map