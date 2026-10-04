export type {
	MemoryProfile,
	MemoryProfileSetting,
	MemoryTier,
} from "../../sqlite/memoryProfile.js";
export {
	createSqliteVectorIndex,
	SqliteVectorIndexClient,
	type SqliteVectorWorkerFactory,
	type SqliteWorkerVectorIndex,
} from "./client.js";
export {
	type SqliteDatabase,
	SqliteDatabaseVectorIndex,
	type SqliteKeyedVectorRecord,
	type SqliteLookupKey,
	type SqliteValue,
	type SqliteVectorIndexOptions,
	type SqliteVectorRuntimeInfo,
} from "./database.js";
export type {
	SqliteVectorPersistence,
	SqliteVectorWorkerOptions,
} from "./protocol.js";
