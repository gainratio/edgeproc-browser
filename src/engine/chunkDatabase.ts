// The engine Worker's SQLite chunk database, opened through the library's own
// SQL seam (SqlEngine + openSqlStorage: opfs-sahpool, the pool owner lock,
// the device memory profile, secure_delete).
//
// Cross-tab: the cache Web Lock and then the pool's owner lock are held for
// one SESSION (the operations this Worker has queued: a sync, a burst of
// reads) and released after it. Tabs take turns on the same persistent file
// instead of one tab owning it for its whole life, and every session opens a
// fresh connection, so it always sees the other tabs' commits.
//
// Fallback: if OPFS is refused (Playwright's WebKit, private browsing), this
// Worker switches to ONE in-memory database for the rest of its life, reports
// it in a typed SqlStorage status, re-downloads each session, and enforces the
// 0.2.x IndexedDB floor if one exists (read-only). It never writes IndexedDB.
// A pool held by a foreign context fails the operation closed instead: an
// empty in-memory floor next to a persisted one could accept a rollback.

import { SqlEngine, type SqlRawDatabase } from "../sql/engine.js";
import { type OpfsDirectory, opfsPoolExists } from "../sql/legacy.js";
import { type OpenedSqlStorage, sqlDatabasePoolName } from "../sql/open.js";
import type { SqlStorage } from "../sql/types.js";
import { SqlStorageUnavailableError } from "../sql/types.js";
import type { MemoryProfile } from "../sqlite/memoryProfile.js";
import { validatedNamespace } from "./cacheLock.js";
import {
	importLegacyFloor,
	LegacyFloorUnavailableError,
	type LegacySource,
	migrateLegacyStores,
} from "./migration.js";
import { SqliteCacheStore } from "./sqliteStore.js";

/** The SQL database a cache namespace's chunks live in. */
export function chunkDatabaseName(namespace: string): string {
	return `${validatedNamespace(namespace)}-chunks`;
}

/** Whether `name`'s opfs-sahpool directory exists. A refused OPFS root is
 * "no" (nothing can have been persisted through it, the same rule the 0.2.x
 * reader uses); any other error propagates, so the caller fails closed. */
export async function persistedSqlPoolExists(
	name: string,
	openRoot: () => Promise<OpfsDirectory>,
): Promise<boolean> {
	let root: OpfsDirectory;
	try {
		root = await openRoot();
	} catch {
		return false;
	}
	return opfsPoolExists(await sqlDatabasePoolName(name), root);
}

export interface ChunkDatabaseOptions {
	readonly namespace: string;
	/** openSqlStorage bound to the Worker's SQLite, with the consumer's
	 * `cacheFallback` ("memory" by default; "none" throws instead). */
	readonly open: (name: string) => Promise<OpenedSqlStorage<SqlRawDatabase>>;
	readonly memoryProfile: MemoryProfile;
	/** The 0.2.x stores to migrate from; only read in persistent mode. */
	readonly legacySources: () => ReadonlyArray<LegacySource>;
	/** Whether the named database's OPFS pool exists on disk (false when the
	 * browser refuses the OPFS root). True means its persisted rollback floor
	 * is out of reach, so the memory fallback is refused. */
	readonly persistedPoolExists: (name: string) => Promise<boolean>;
	readonly warn: (message: string) => void;
	/** The cross-tab cache lock (a Web Lock in the Worker). Default: none. */
	readonly withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export type ChunkOperation<T> = (
	store: SqliteCacheStore,
	storage: SqlStorage,
) => Promise<T>;

/** `shared`: read-only, so it may run alongside other shared operations
 * (each still a sequence of synchronous SQLite calls on one connection). */
export interface ChunkRunOptions {
	readonly shared?: boolean;
	/** The user's explicit cache reset: runs even when a legacy floor is
	 * unreadable, and deletes the legacy stores after it. */
	readonly reset?: boolean;
}

interface Queued {
	readonly shared: boolean;
	readonly reset: boolean;
	readonly operation: ChunkOperation<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

interface Session {
	readonly store: SqliteCacheStore;
	readonly storage: SqlStorage;
	/** Set when a legacy rollback floor could not be read: only an explicit
	 * reset may run, everything else fails closed with this error. */
	readonly floorRefusal: LegacyFloorUnavailableError | null;
	close(): Promise<void>;
}

/**
 * One session = the cross-tab cache lock, then the SQLite pool, held while
 * this Worker has queued operations (an app reading 25 files is one session,
 * not 25 opens), then both released. Another tab waits on the cache lock, not
 * on the pool, so it can never time out into the memory fallback because of
 * this tab.
 */
export class ChunkDatabase {
	readonly #options: ChunkDatabaseOptions;
	readonly #queue: Queued[] = [];
	#draining: Promise<void> | null = null;
	#memory: {
		readonly engine: SqlEngine;
		readonly storage: SqlStorage;
	} | null = null;
	#migrated = false;

	public constructor(options: ChunkDatabaseOptions) {
		this.#options = options;
	}

	public run<T>(
		operation: ChunkOperation<T>,
		options: ChunkRunOptions = {},
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.#queue.push({
				shared: options.shared === true,
				reset: options.reset === true,
				operation,
				resolve: resolve as (value: unknown) => void,
				reject,
			});
			this.#draining ??= this.#drain().finally(() => {
				this.#draining = null;
			});
		});
	}

	/** Resolves once no session is open (the locks are free). */
	public idle(): Promise<void> {
		return this.#draining ?? Promise.resolve();
	}

	async #drain(): Promise<void> {
		const withLock =
			this.#options.withLock ?? (<T>(work: () => Promise<T>) => work());
		while (this.#queue.length > 0) {
			await withLock(() => this.#session()).catch((error: unknown) => {
				for (const queued of this.#queue.splice(0)) queued.reject(error);
			});
		}
	}

	async #session(): Promise<void> {
		const session = await this.#open();
		try {
			for (
				let batch = this.#nextBatch();
				batch.length > 0;
				batch = this.#nextBatch()
			) {
				await Promise.all(batch.map((queued) => this.#runOne(session, queued)));
			}
		} finally {
			await session.close();
		}
	}

	async #runOne(session: Session, queued: Queued): Promise<void> {
		const { operation, resolve, reject, reset } = queued;
		if (session.floorRefusal !== null && !reset) {
			reject(session.floorRefusal);
			return;
		}
		try {
			const value = await withFlush(session.store, () =>
				operation(session.store, session.storage),
			);
			if (reset) {
				for (const source of this.#options.legacySources()) {
					await source.remove();
				}
			}
			resolve(value);
		} catch (error) {
			reject(error);
		}
	}

	/** The next exclusive operation alone, or every leading shared one. */
	#nextBatch(): Queued[] {
		const first = this.#queue[0];
		if (first === undefined) return [];
		if (!first.shared) return this.#queue.splice(0, 1);
		const end = this.#queue.findIndex((queued) => !queued.shared);
		return this.#queue.splice(0, end === -1 ? this.#queue.length : end);
	}

	async #open(): Promise<Session> {
		if (this.#memory !== null) return this.#memorySession(this.#memory);
		const name = chunkDatabaseName(this.#options.namespace);
		const opened = await this.#options.open(name);
		if (opened.storage.persistence === "memory") {
			await opened.release();
			if (opened.storage.reason === "pool-in-use") {
				// A persisted floor exists in a file we cannot open right now. An
				// empty in-memory floor beside it could accept a rollback: refuse.
				opened.raw.close();
				throw new SqlStorageUnavailableError(
					"pool-in-use",
					`chunk database is held by another context (${opened.storage.detail ?? "pool-in-use"}); retry`,
				);
			}
			await this.#refuseBesidePersistedFloor(
				name,
				opened.raw,
				opened.storage.detail ?? opened.storage.reason,
			);
			const engine = this.#engine(opened.raw, opened.storage);
			const memory = {
				engine,
				storage: opened.storage,
				floorRefusal: await this.#legacyFloorInto(
					SqliteCacheStore.open(engine),
				),
			};
			this.#memory = memory.floorRefusal === null ? memory : null;
			return this.#memorySession(memory);
		}
		let engine: SqlEngine | undefined;
		const close = async (): Promise<void> => {
			try {
				if (engine === undefined) opened.raw.close();
				else engine.close();
			} finally {
				await opened.release();
			}
		};
		try {
			engine = this.#engine(opened.raw, opened.storage);
			const store = SqliteCacheStore.open(engine);
			const floorRefusal = await this.#migrateOnce(store);
			return { store, storage: opened.storage, floorRefusal, close };
		} catch (error) {
			await close();
			throw error;
		}
	}

	/** OPFS failed for another reason. If this database's pool is on disk,
	 * its floor is too: an empty in-memory floor beside it could accept a
	 * rollback, so refuse (an error deciding that refuses as well). */
	async #refuseBesidePersistedFloor(
		name: string,
		raw: SqlRawDatabase,
		detail: string,
	): Promise<void> {
		let exists = true;
		try {
			exists = await this.#options.persistedPoolExists(name);
		} finally {
			if (exists) raw.close();
		}
		if (exists) {
			throw new SqlStorageUnavailableError(
				"opfs-unavailable",
				`chunk database exists on disk but could not be opened (${detail}); refusing to run without its rollback floor`,
			);
		}
	}

	/** Memory mode (OPFS refused): no SQLite floor can persist, so the 0.2.x
	 * IndexedDB floor, if any, is read (never written, never deleted) and
	 * enforced for this Worker's life. */
	async #legacyFloorInto(
		store: SqliteCacheStore,
	): Promise<LegacyFloorUnavailableError | null> {
		try {
			await importLegacyFloor(store, this.#options.legacySources());
			return null;
		} catch (error) {
			if (error instanceof LegacyFloorUnavailableError) return error;
			throw error;
		}
	}

	#memorySession(memory: {
		readonly engine: SqlEngine;
		readonly storage: SqlStorage;
		readonly floorRefusal?: LegacyFloorUnavailableError | null;
	}): Session {
		return {
			store: SqliteCacheStore.open(memory.engine),
			storage: memory.storage,
			floorRefusal: memory.floorRefusal ?? null,
			close: async () => undefined,
		};
	}

	#engine(raw: SqlRawDatabase, storage: SqlStorage): SqlEngine {
		return new SqlEngine(raw, {
			storage,
			memoryProfile: this.#options.memoryProfile,
		});
	}

	/** A failed BULK copy never blocks the operation: the legacy floor was
	 * imported first, the sync re-downloads, nothing legacy is deleted, and
	 * the next session tries again. An unreadable FLOOR blocks everything but
	 * an explicit reset (returned as the session's refusal). */
	async #migrateOnce(
		store: SqliteCacheStore,
	): Promise<LegacyFloorUnavailableError | null> {
		if (this.#migrated) return null;
		try {
			await migrateLegacyStores(store, this.#options.legacySources());
			this.#migrated = true;
		} catch (error) {
			if (error instanceof LegacyFloorUnavailableError) return error;
			this.#options.warn(
				`legacy cache migration did not complete (${error instanceof Error ? error.message : String(error)}); re-downloading`,
			);
		}
		return null;
	}
}

/** Verified chunks still in the ingest buffer are committed even when the
 * operation fails, so an interrupted sync resumes instead of restarting. */
async function withFlush<T>(
	store: SqliteCacheStore,
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} finally {
		await store.flush();
	}
}
