// How the vector Worker owns its opfs-sahpool: the same exclusive owner Web
// Lock openSqlDatabase holds, for the life of the index. Kept free of Worker
// globals so the lifecycle is unit-tested, not just driven in a browser.

import {
	acquirePoolLease,
	poolOwnerLock,
	type SqlLocks,
} from "../../sql/open.js";
import { SqlStorageUnavailableError } from "../../sql/types.js";

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
export async function ownPool<P extends PausablePool>(
	locks: SqlLocks | undefined,
	poolName: string,
	waitMs: number,
	install: () => Promise<P>,
): Promise<OwnedPool<P>> {
	const releaseLock = await acquirePoolLease(
		locks,
		poolOwnerLock(poolName),
		waitMs,
	);
	if (releaseLock === undefined) {
		throw new SqlStorageUnavailableError(
			"pool-in-use",
			`could not open the local vector database: another tab or Worker still owns it after ${waitMs} ms`,
		);
	}
	let pool: P;
	try {
		pool = await install();
	} catch (error) {
		await releaseLock();
		throw error;
	}
	return {
		pool,
		release: async () => {
			try {
				pool.pauseVfs();
			} finally {
				await releaseLock();
			}
		},
	};
}

/**
 * Close the index, then free its pool. Resolves only once the handles are
 * closed and the owner lock is free, so a caller that awaits dispose() can
 * remove or reopen the pool at once.
 */
export async function disposeOwned(
	index: { dispose(): Promise<void> | void },
	release: () => Promise<void>,
): Promise<void> {
	try {
		await index.dispose();
	} finally {
		await release();
	}
}
