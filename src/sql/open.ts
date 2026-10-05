// Where a named SQL database lives: its own opfs-sahpool VFS in OPFS, owned by
// exactly one context at a time.
//
// opfs-sahpool pre-opens exclusive sync access handles, so only one tab (or
// Worker) per origin can have a pool installed; SQLite leaves that coordination
// to the application. We take it with an exclusive Web Lock held for the life
// of the connection. A second tab waits briefly (a reload overlaps the old page
// for a moment), then either fails closed or, if the caller allowed it, opens
// an in-memory database and SAYS SO in its storage status.

import type { MemoryTier } from "../sqlite/memoryProfile.js";
import {
	type SqlDatabaseOptions,
	type SqlFallbackReason,
	type SqlStorage,
	SqlStorageUnavailableError,
} from "./types.js";

/** The slice of the Web Locks API this module uses. */
export interface SqlLocks {
	request<T>(
		name: string,
		options: {
			readonly mode?: "exclusive";
			readonly signal?: AbortSignal;
			readonly ifAvailable?: boolean;
		},
		callback: (lock: unknown) => Promise<T>,
	): Promise<T>;
	/** Web Locks snapshot; used to confirm a live owner after a timed-out wait. */
	query?(): Promise<{
		readonly held?: ReadonlyArray<{ readonly name?: string }>;
	}>;
}

/**
 * How long to wait for a pool's previous owner to let go. close() now hands
 * the lock back within milliseconds, so what the wait really covers is a page
 * reload overlapping its predecessor while the browser tears that page's
 * Worker down — slowest on the weakest devices, so the budget scales with the
 * memory tier rather than being one fixed number.
 */
export function ownerLockWaitMs(tier: MemoryTier): number {
	return OWNER_LOCK_WAIT_MS[tier];
}

const OWNER_LOCK_WAIT_MS: Readonly<Record<MemoryTier, number>> = Object.freeze({
	full: 1_000,
	lite: 2_000,
	minimal: 4_000,
});

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

export const SQL_POOL_PREFIX = "edgeproc-sql-";

/** The opfs-sahpool VFS name a database name maps to (OPFS dir: `.${pool}`). */
export async function sqlDatabasePoolName(name: string): Promise<string> {
	return `${SQL_POOL_PREFIX}${await stableIdentity(name)}`;
}

export interface OpenSqlStorageContext {
	/**
	 * A bounded operation (an import, export or migration by name), not a
	 * connection: it also holds `${pool}-operation`, so a context that times
	 * out waiting for the owner lock knows to wait for it to finish.
	 */
	readonly transient?: boolean;
}

export async function openSqlStorage<R>(
	deps: SqlStorageDeps<R>,
	options: SqlDatabaseOptions,
	{ transient = false }: OpenSqlStorageContext = {},
): Promise<OpenedSqlStorage<R>> {
	const persistence = options.persistence ?? "opfs";
	if (persistence === "memory") {
		return {
			raw: deps.openMemory(),
			storage: { persistence: "memory", reason: "requested" },
			release: async () => undefined,
		};
	}
	if (persistence !== "opfs") {
		throw new TypeError(`unsupported SQL persistence: ${String(persistence)}`);
	}
	const pool = await sqlDatabasePoolName(options.name);
	const owner = await acquireOwnerLease(deps, pool);
	if (owner === undefined) {
		return fallBack(deps, options, "pool-in-use", "another context owns it");
	}
	const release = transient ? await markOperation(deps, pool, owner) : owner;
	try {
		const vfs = await deps.installPool(pool);
		const file = `/${pool}.sqlite3`;
		return {
			raw: new vfs.OpfsSAHPoolDb(file),
			storage: { persistence: "opfs", pool, file },
			// Free the handles BEFORE the lock, so the next owner (a reopen, a
			// reloaded tab) can open them the moment it gets the lock.
			release: async () => {
				try {
					vfs.pauseVfs?.();
				} finally {
					await release();
				}
			},
		};
	} catch (error) {
		await release();
		const reason = isPoolContentionError(error)
			? "pool-in-use"
			: "opfs-unavailable";
		return fallBack(deps, options, reason, describe(error));
	}
}

function fallBack<R>(
	deps: SqlStorageDeps<R>,
	options: SqlDatabaseOptions,
	reason: SqlFallbackReason,
	detail: string,
): OpenedSqlStorage<R> {
	const message = `SQL database "${options.name}" could not use OPFS (${reason}: ${detail})`;
	if ((options.fallback ?? "none") !== "memory") {
		throw new SqlStorageUnavailableError(reason, message);
	}
	deps.warn(`${message}; opened in memory instead`);
	return {
		raw: deps.openMemory(),
		storage: { persistence: "memory", reason, detail },
		release: async () => undefined,
	};
}

type Lease = () => Promise<void>;

/**
 * The owner lock, waiting `lockWaitMs` for a previous connection (a reload).
 * If that wait runs out while a bounded operation holds the pool, wait for the
 * operation to finish: it will, and failing would break "a writer waits for
 * an import by name". If the owner let go between the timeout and the check,
 * take the lock again within the same budget. A live connection: undefined.
 */
async function acquireOwnerLease<R>(
	deps: SqlStorageDeps<R>,
	pool: string,
): Promise<Lease | undefined> {
	const owner = poolOwnerLock(pool);
	const lease = await acquirePoolLease(deps.locks, owner, deps.lockWaitMs);
	if (lease !== undefined || deps.locks?.query === undefined) return lease;
	const held = new Set(
		((await deps.locks.query()).held ?? []).map((lock) => lock.name),
	);
	if (held.has(poolOperationLock(pool))) {
		return acquirePoolLease(deps.locks, owner, Number.POSITIVE_INFINITY);
	}
	if (!held.has(owner)) {
		return acquirePoolLease(deps.locks, owner, deps.lockWaitMs);
	}
	return undefined;
}

/** Hold `${pool}-operation` too; free it only after the owner lock. */
async function markOperation<R>(
	deps: SqlStorageDeps<R>,
	pool: string,
	owner: Lease,
): Promise<Lease> {
	// Free whenever the owner lock is ours: nobody else takes it without it.
	const marker = await acquirePoolLease(
		deps.locks,
		poolOperationLock(pool),
		deps.lockWaitMs,
	);
	return async () => {
		try {
			await owner();
		} finally {
			await marker?.();
		}
	};
}

/** Held, alongside the owner lock, by a bounded operation on `pool`. */
export function poolOperationLock(pool: string): string {
	return `${pool}-operation`;
}

/** The Web Lock every owner of the opfs-sahpool `pool` holds while open. */
export function poolOwnerLock(pool: string): string {
	return `${pool}-owner`;
}

/**
 * Hold an exclusive lock until the returned release() is called; undefined if
 * it stayed taken for `waitMs` (Infinity: wait as long as it takes). release() resolves once the lock manager has
 * actually let go (the request's promise settles after the release), which is
 * what lets close() promise "the next owner can have it now".
 */
export function acquirePoolLease(
	locks: SqlLocks | undefined,
	name: string,
	waitMs: number,
): Promise<(() => Promise<void>) | undefined> {
	if (locks === undefined) return Promise.resolve(async () => undefined);
	let unhold: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		unhold = resolve;
	});
	return new Promise((resolve, reject) => {
		const settled = locks.request(
			name,
			Number.isFinite(waitMs)
				? { mode: "exclusive", signal: AbortSignal.timeout(waitMs) }
				: { mode: "exclusive" },
			async () => {
				resolve(async () => {
					unhold();
					await settled;
				});
				await held;
			},
		);
		settled.catch((error: unknown) => {
			if (isLockTimeout(error)) resolve(undefined);
			else reject(error);
		});
	});
}

/** DOMException is not an Error subclass in every realm, so match by name. */
export function isLockTimeout(error: unknown): boolean {
	const name = (error as { readonly name?: unknown } | null)?.name;
	return name === "AbortError" || name === "TimeoutError";
}

export function isPoolContentionError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "NoModificationAllowedError" ||
			/access handles? cannot be created|NoModificationAllowedError/i.test(
				error.message,
			))
	);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function stableIdentity(name: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)),
	);
	return [...digest]
		.slice(0, 16)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}
