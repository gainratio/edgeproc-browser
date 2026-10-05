import type { TempStore } from "../sqlite/memoryProfile.js";
/** The slice of an installed pool (sqlite3.mjs's PoolUtil) used here. */
export interface SahPoolHandle {
    readonly OpfsSAHPoolDb: new (file: string) => unknown;
    pauseVfs(): unknown;
    isPaused(): boolean;
    unpauseVfs(): Promise<unknown>;
}
/** The slot accounting a top-up needs. */
export interface SahPoolSlots {
    /** Files currently taking a slot (sqlite3.mjs getFileNames()). */
    getFileNames(): ReadonlyArray<string>;
    /** Add slots until there are at least `min`; resolves to the capacity. */
    reserveMinimumCapacity(min: number): Promise<number>;
}
/**
 * Slots kept free for SQLite's temp files. With temp_store=MEMORY (the
 * "full" and "lite" tiers) temp tables, sorts and statement journals stay in
 * memory and take none. With temp_store=FILE (the "minimal" tier) one
 * statement can hold a statement journal, the temp database, a sorter that
 * spilled and a transient index (GROUP BY / DISTINCT) at once: 4. That puts
 * one database on the minimal tier at sqlite-wasm's own default of 6.
 */
export declare const TEMP_FILE_SLOTS: Readonly<Record<TempStore, number>>;
/**
 * Slots `databaseFile` needs: every file already in use (a leftover journal
 * included), the database and its rollback journal (journal_mode=DELETE),
 * and the temp-file slots for `tempStore`.
 */
export declare function sahPoolSlotsNeeded(inUse: ReadonlyArray<string>, databaseFile: string, tempStore: TempStore): number;
/** Top `pool` up to what `databaseFile` needs; a no-op when it has enough. */
export declare function reserveSahPoolSlots(pool: SahPoolSlots, databaseFile: string, tempStore: TempStore): Promise<number>;
/**
 * Set up (or resume) the pool `name`. A failure keeps the pool's files and
 * may be retried: the next call starts a fresh setup instead of returning
 * the cached failure.
 */
export declare function installSahPool<P extends SahPoolHandle>(sqlite: {
    installOpfsSAHPoolVfs(options: SahPoolInstallOptions): Promise<P>;
}, name: string): Promise<P>;
export interface SahPoolInstallOptions {
    readonly name: string;
    readonly forceReinitIfPreviouslyFailed: true;
    readonly preserveOnInitFailure: true;
}
/** The installer options every pool in this library is set up with. */
export declare function sahPoolInstallOptions(name: string): SahPoolInstallOptions;
//# sourceMappingURL=sahPool.d.ts.map