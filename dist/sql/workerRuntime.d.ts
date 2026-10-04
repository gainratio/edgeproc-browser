import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import type { SqlRawDatabase } from "./engine.js";
import type { SqlStorageDeps } from "./open.js";
export type LoadedSqlite = Awaited<ReturnType<typeof sqlite3InitModule>>;
/** The pinned SQLite module, loaded once per Worker. */
export declare function loadSqlite(): Promise<LoadedSqlite>;
/**
 * openSqlStorage deps for this Worker. The pool is installed once; a pool a
 * previous operation paused (released its handles) is resumed before use.
 */
export declare function workerStorageDeps(sqlite: LoadedSqlite, lockWaitMs: number): SqlStorageDeps<SqlRawDatabase>;
//# sourceMappingURL=workerRuntime.d.ts.map