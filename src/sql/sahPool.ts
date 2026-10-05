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
export const TEMP_FILE_SLOTS: Readonly<Record<TempStore, number>> =
	Object.freeze({ memory: 0, file: 4 });

/**
 * Slots `databaseFile` needs: every file already in use (a leftover journal
 * included), the database and its rollback journal (journal_mode=DELETE),
 * and the temp-file slots for `tempStore`.
 */
export function sahPoolSlotsNeeded(
	inUse: ReadonlyArray<string>,
	databaseFile: string,
	tempStore: TempStore,
): number {
	const files = new Set([...inUse, databaseFile, `${databaseFile}-journal`]);
	return files.size + TEMP_FILE_SLOTS[tempStore];
}

/** Top `pool` up to what `databaseFile` needs; a no-op when it has enough. */
export async function reserveSahPoolSlots(
	pool: SahPoolSlots,
	databaseFile: string,
	tempStore: TempStore,
): Promise<number> {
	return pool.reserveMinimumCapacity(
		sahPoolSlotsNeeded(pool.getFileNames(), databaseFile, tempStore),
	);
}

/**
 * Set up (or resume) the pool `name`. A failure keeps the pool's files and
 * may be retried: the next call starts a fresh setup instead of returning
 * the cached failure.
 */
export async function installSahPool<P extends SahPoolHandle>(
	sqlite: { installOpfsSAHPoolVfs(options: SahPoolInstallOptions): Promise<P> },
	name: string,
): Promise<P> {
	const pool = await sqlite.installOpfsSAHPoolVfs(sahPoolInstallOptions(name));
	if (pool.isPaused()) await pool.unpauseVfs();
	return pool;
}

export interface SahPoolInstallOptions {
	readonly name: string;
	readonly forceReinitIfPreviouslyFailed: true;
	readonly preserveOnInitFailure: true;
}

/** The installer options every pool in this library is set up with. */
export function sahPoolInstallOptions(name: string): SahPoolInstallOptions {
	return {
		name,
		forceReinitIfPreviouslyFailed: true,
		preserveOnInitFailure: true,
	};
}
