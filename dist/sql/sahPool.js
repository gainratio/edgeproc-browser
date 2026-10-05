// How this library sets up an opfs-sahpool, in one place for every Worker that
// owns one (the /sql seam, the engine's chunk cache, the vector index).
//
// opfs-sahpool keeps a fixed set of pre-created OPFS files ("slots"); every
// file SQLite opens (the database, its rollback journal, temp files) takes
// one. sqlite-wasm creates 6 slots the first time a pool is set up and never
// adds more on its own: a later setup that finds any slot keeps what it finds.
// Two guards keep a pool from running out:
//
// 1. A failed setup keeps its slots (`preserveOnInitFailure`, SQLite check-in
//    ad1bbfc2bd, local patch 0005). Without it a setup that lost a race with
//    a reload's dying Worker deleted every slot it could reach.
// 2. After every setup the pool is topped up to what its database needs
//    (sahPoolSlotsNeeded), so a pool that lost slots anyway heals.
/**
 * Slots kept free for SQLite's temp files. With temp_store=MEMORY (the
 * "full" and "lite" tiers) temp tables, sorts and statement journals stay in
 * memory and take none. With temp_store=FILE (the "minimal" tier) one
 * statement can hold a statement journal, the temp database, a sorter that
 * spilled and a transient index (GROUP BY / DISTINCT) at once: 4. That puts
 * one database on the minimal tier at sqlite-wasm's own default of 6.
 */
export const TEMP_FILE_SLOTS = Object.freeze({ memory: 0, file: 4 });
/**
 * Slots `databaseFile` needs: every file already in use (a leftover journal
 * included), the database and its rollback journal (journal_mode=DELETE),
 * and the temp-file slots for `tempStore`.
 */
export function sahPoolSlotsNeeded(inUse, databaseFile, tempStore) {
    const files = new Set([...inUse, databaseFile, `${databaseFile}-journal`]);
    return files.size + TEMP_FILE_SLOTS[tempStore];
}
/** Top `pool` up to what `databaseFile` needs; a no-op when it has enough. */
export async function reserveSahPoolSlots(pool, databaseFile, tempStore) {
    return pool.reserveMinimumCapacity(sahPoolSlotsNeeded(pool.getFileNames(), databaseFile, tempStore));
}
/**
 * Set up (or resume) the pool `name`. A failure keeps the pool's files and
 * may be retried: the next call starts a fresh setup instead of returning
 * the cached failure.
 */
export async function installSahPool(sqlite, name) {
    const pool = await sqlite.installOpfsSAHPoolVfs(sahPoolInstallOptions(name));
    if (pool.isPaused())
        await pool.unpauseVfs();
    return pool;
}
/** The installer options every pool in this library is set up with. */
export function sahPoolInstallOptions(name) {
    return {
        name,
        forceReinitIfPreviouslyFailed: true,
        preserveOnInitFailure: true,
    };
}
//# sourceMappingURL=sahPool.js.map