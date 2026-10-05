// Worker-only: load the pinned SQLite build and describe how to open a named
// database on it (opfs-sahpool, owner-locked; memory as the reported
// fallback). Shared by the SQL Worker and the engine Worker's chunk store, so
// both open SQLite exactly the same way. Proven in a real browser by the
// Playwright specs; it touches Worker globals, so it is not unit-tested.

import type { TempStore } from "../sqlite/memoryProfile.js";
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { configureInlineOpfsProxy } from "../vector/sqlite/opfsAsyncProxy.js";
import type { SqlRawDatabase } from "./engine.js";
import type { SqlLocks, SqlStorageDeps } from "./open.js";
import { installSahPool } from "./sahPool.js";

export type LoadedSqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;

let loading: Promise<LoadedSqlite> | undefined;

/** The pinned SQLite module, loaded once per Worker. */
export function loadSqlite(): Promise<LoadedSqlite> {
	loading ??= (async () => {
		configureInlineOpfsProxy();
		return sqlite3InitModule({
			print: () => undefined,
			printErr: (...args) => console.error(...args),
		});
	})();
	return loading;
}

/**
 * openSqlStorage deps for this Worker. The pool is installed once (see
 * sahPool.ts); a pool a previous operation paused (released its handles) is
 * resumed before use. `tempStore` is the connection's PRAGMA temp_store,
 * which decides how many pool slots its temp files need.
 */
export function workerStorageDeps(
	sqlite: LoadedSqlite,
	lockWaitMs: number,
	tempStore: TempStore,
): SqlStorageDeps<SqlRawDatabase> {
	return {
		openMemory: (): SqlRawDatabase => new sqlite.oo1.DB(":memory:"),
		installPool: (name) => installSahPool(sqlite, name),
		locks: (navigator as { locks?: SqlLocks }).locks,
		warn: (message) => console.warn(message),
		lockWaitMs,
		tempStore,
	};
}
