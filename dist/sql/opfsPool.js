// Delete an opfs-sahpool VFS's storage: retire a database you no longer use, or
// clean up the pool an older build left behind for returning visitors.
//
// opfs-sahpool keeps everything for a pool named P under the OPFS directory
// `.P` (sqlite3.mjs: `vfsDir = options.directory || "." + vfsName`), so
// removing that directory removes the pool. Removal is idempotent: a missing
// pool is "absent", and a pool another live context still owns is "in-use"
// (nothing is deleted; try again once that context closes it).
//
// Every owner (openSqlDatabase, createSqliteVectorIndex with OPFS) holds the
// pool's exclusive owner Web Lock while open and releases it only after its
// sync access handles are closed. Removal takes that same lock, waiting a
// bounded time for an owner that is just closing, and deletes while holding
// it, so nothing can reopen the pool mid-delete. A pool still owned after the
// wait, or whose files a lock-less context holds open, is "in-use".
import { resolveMemoryProfile } from "../sqlite/memoryProfile.js";
import { acquirePoolLease, ownerLockWaitMs, poolOwnerLock, sqlDatabasePoolName, stableIdentity, } from "./open.js";
import { SqlStorageUnavailableError } from "./types.js";
const SAFE_POOL_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Remove the opfs-sahpool named `poolName` (its directory `.${poolName}`). */
export async function removeOpfsPool(poolName, options = {}) {
    if (!SAFE_POOL_NAME.test(poolName) || poolName === "..") {
        throw new TypeError(`invalid OPFS pool name: ${JSON.stringify(poolName)}`);
    }
    const locks = "locks" in options ? options.locks : defaultLocks();
    const release = await acquirePoolLease(locks, poolOwnerLock(poolName), options.lockWaitMs ?? ownerLockWaitMs(resolveMemoryProfile("auto").tier));
    if (release === undefined)
        return confirmOwner(locks, poolName);
    try {
        return await removeUnderLease(poolName, options);
    }
    finally {
        await release();
    }
}
/** After a timed-out wait: "in-use" only if the lock manager shows the owner. */
async function confirmOwner(locks, poolName) {
    const snapshot = await locks?.query?.();
    const owner = poolOwnerLock(poolName);
    return snapshot?.held?.some((lock) => lock.name === owner)
        ? "in-use"
        : "timeout";
}
async function removeUnderLease(poolName, options) {
    const root = options.root ?? (await defaultRoot());
    try {
        await root.removeEntry(`.${poolName}`, { recursive: true });
        return "removed";
    }
    catch (error) {
        const name = error?.name;
        if (name === "NotFoundError")
            return "absent";
        if (name === "NoModificationAllowedError" ||
            name === "InvalidModificationError") {
            return "in-use";
        }
        throw error;
    }
}
/**
 * Remove a database opened with `openSqlDatabase({ name })`: its pool, under
 * the same owner lock the open holds (see {@link removeOpfsPool}).
 */
export async function removeSqlDatabase(name, options = {}) {
    return removeOpfsPool(await sqlDatabasePoolName(name), options);
}
/** The pool `createSqliteVectorIndex({ name, persistence: "opfs" })` uses. */
export async function sqliteVectorPoolName(name) {
    return `edgeproc-vector-${await stableIdentity(name)}`;
}
/**
 * The OPFS root, or the same typed refusal openSqlDatabase reports. A browser
 * that refuses the root (Safari private mode, Playwright's WebKit) throws a
 * bare DOMException like "UnknownError"; callers branch on the type instead.
 */
async function defaultRoot() {
    try {
        return await navigator.storage.getDirectory();
    }
    catch (error) {
        throw new SqlStorageUnavailableError("opfs-unavailable", `OPFS root refused: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function defaultLocks() {
    return globalThis.navigator?.locks;
}
//# sourceMappingURL=opfsPool.js.map