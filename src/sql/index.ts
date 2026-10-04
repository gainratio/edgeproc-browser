// @gainratio/browser/sql — a typed SQL seam over the library's own SQLite build
// (SQLite 3.53.4 + FTS5 + JSON1 + sqlite-vector 1.1.2), run in its Worker, on
// OPFS, with the device memory profile applied. No consumer imports sqlite3
// files by path.
export type {
	MemoryProfile,
	MemoryProfileSetting,
	MemoryTier,
} from "../sqlite/memoryProfile.js";
export {
	exportDatabase,
	importDatabase,
	type OpenSqlDatabaseOptions,
	openSqlDatabase,
	type SqlDatabase,
	type SqlPreparedStatement,
	type SqlWorkerFactory,
	type SqlWorkerLike,
} from "./client.js";
export { PINNED_SQLITE_VERSION, PINNED_VECTOR_VERSION } from "./engine.js";
export { sqlDatabasePoolName } from "./open.js";
export {
	type OpfsPoolRemoval,
	type OpfsRoot,
	type RemoveOpfsPoolOptions,
	type RemoveSqlDatabaseOptions,
	removeOpfsPool,
	removeSqlDatabase,
	sqliteVectorPoolName,
} from "./opfsPool.js";
export type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";
export {
	type SqlBind,
	type SqlBindValue,
	type SqlDatabaseOptions,
	type SqlExecResult,
	type SqlExpectedSchema,
	type SqlFallbackReason,
	type SqlImportOptions,
	SqlImportRejectedError,
	type SqlImportRejection,
	type SqlImportResult,
	type SqlRow,
	type SqlRuntimeInfo,
	type SqlStatement,
	type SqlStorage,
	SqlStorageUnavailableError,
	type SqlTransactionResult,
	type SqlValue,
} from "./types.js";
