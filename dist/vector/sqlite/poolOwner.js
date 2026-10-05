// How the vector Worker owns its opfs-sahpool: the same exclusive owner Web
// Lock openSqlDatabase holds, for the life of the index. Kept free of Worker
// globals so the lifecycle is unit-tested, not just driven in a browser.
import { acquirePoolLease, poolOwnerLock, } from "../../sql/open.js";
import { reserveSahPoolSlots } from "../../sql/sahPool.js";
import { SqlStorageUnavailableError } from "../../sql/types.js";
/**
 * Take `poolName`'s owner lock (waiting up to `waitMs` for a previous owner),
 * then install the pool. Another live owner is a typed "pool-in-use" refusal.
 */
export async function ownPool(locks, poolName, waitMs, install) {
    const releaseLock = await acquirePoolLease(locks, poolOwnerLock(poolName), waitMs);
    if (releaseLock === undefined) {
        throw new SqlStorageUnavailableError("pool-in-use", `could not open the local vector database: another tab or Worker still owns it after ${waitMs} ms`);
    }
    let pool;
    try {
        pool = await install();
    }
    catch (error) {
        await releaseLock();
        throw error;
    }
    return {
        pool,
        release: async () => {
            try {
                pool.pauseVfs();
            }
            finally {
                await releaseLock();
            }
        },
    };
}
/**
 * Own `poolName` (ownPool), top its slots up to what its database file
 * `/${poolName}.sqlite3` needs for `tempStore`, then open that file.
 */
export async function openOwnedDatabase(locks, poolName, waitMs, tempStore, install) {
    const owned = await ownPool(locks, poolName, waitMs, install);
    try {
        const file = `/${poolName}.sqlite3`;
        await reserveSahPoolSlots(owned.pool, file, tempStore);
        const raw = new owned.pool.OpfsSAHPoolDb(file);
        return {
            raw: raw,
            release: owned.release,
        };
    }
    catch (error) {
        await owned.release();
        throw error;
    }
}
/**
 * Close the index, then free its pool. Resolves only once the handles are
 * closed and the owner lock is free, so a caller that awaits dispose() can
 * remove or reopen the pool at once.
 */
export async function disposeOwned(index, release) {
    try {
        await index.dispose();
    }
    finally {
        await release();
    }
}
//# sourceMappingURL=poolOwner.js.map