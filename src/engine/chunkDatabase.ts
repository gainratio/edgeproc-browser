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
// Fallback: if OPFS is refused (Playwright's WebKit, private browsing) or a
// foreign context holds the pool, this Worker switches to ONE in-memory
// database for the rest of its life, reports it in a typed SqlStorage status,
// and re-downloads each session. It never falls back to IndexedDB.

import { SqlEngine, type SqlRawDatabase } from "../sql/engine.js";
import type { OpenedSqlStorage } from "../sql/open.js";
import type { SqlStorage } from "../sql/types.js";
import type { MemoryProfile } from "../sqlite/memoryProfile.js";
import { validatedNamespace } from "./cacheLock.js";
import { type LegacySource, migrateLegacyStores } from "./migration.js";
import { SqliteCacheStore } from "./sqliteStore.js";

/** The SQL database a cache namespace's chunks live in. */
export function chunkDatabaseName(namespace: string): string {
	return `${validatedNamespace(namespace)}-chunks`;
}

export interface ChunkDatabaseOptions {
	readonly namespace: string;
	/** openSqlStorage with `fallback: "memory"`, bound to the Worker's SQLite. */
	readonly open: (name: string) => Promise<OpenedSqlStorage<SqlRawDatabase>>;
	readonly memoryProfile: MemoryProfile;
	/** The 0.2.x stores to migrate from; only read in persistent mode. */
	readonly legacySources: () => ReadonlyArray<LegacySource>;
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
}

interface Queued {
	readonly shared: boolean;
	readonly operation: ChunkOperation<unknown>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

interface Session {
	readonly store: SqliteCacheStore;
	readonly storage: SqlStorage;
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
	#memory: { readonly engine: SqlEngine; readonly storage: SqlStorage } | null =
		null;
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
				await Promise.all(
					batch.map(({ operation, resolve, reject }) =>
						withFlush(session.store, () =>
							operation(session.store, session.storage),
						).then(resolve, reject),
					),
				);
			}
		} finally {
			await session.close();
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
		const opened = await this.#options.open(
			chunkDatabaseName(this.#options.namespace),
		);
		if (opened.storage.persistence === "memory") {
			this.#memory = {
				engine: this.#engine(opened.raw, opened.storage),
				storage: opened.storage,
			};
			await opened.release();
			return this.#memorySession(this.#memory);
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
			await this.#migrateOnce(store);
			return { store, storage: opened.storage, close };
		} catch (error) {
			await close();
			throw error;
		}
	}

	#memorySession(memory: {
		readonly engine: SqlEngine;
		readonly storage: SqlStorage;
	}): Session {
		return {
			store: SqliteCacheStore.open(memory.engine),
			storage: memory.storage,
			close: async () => undefined,
		};
	}

	#engine(raw: SqlRawDatabase, storage: SqlStorage): SqlEngine {
		return new SqlEngine(raw, {
			storage,
			memoryProfile: this.#options.memoryProfile,
		});
	}

	/** A failed migration never blocks the operation: the sync re-downloads,
	 * nothing legacy is deleted, and the next session tries again. */
	async #migrateOnce(store: SqliteCacheStore): Promise<void> {
		if (this.#migrated) return;
		try {
			await migrateLegacyStores(store, this.#options.legacySources());
			this.#migrated = true;
		} catch (error) {
			this.#options.warn(
				`legacy cache migration did not complete (${error instanceof Error ? error.message : String(error)}); re-downloading`,
			);
		}
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
