// How the engine Worker opens its chunk-cache pool: the library's SQL seam
// (openSqlStorage), with the pool topped up for the SAME memory profile the
// chunk database applies. temp_store=FILE (the "minimal" tier) needs slots
// for temp files; a wrong profile here is how a pool runs out of slots.

import type { SqlRawDatabase } from "../sql/engine.js";
import type { SqlStorageDeps } from "../sql/open.js";
import { type LoadedSqlite, workerStorageDeps } from "../sql/workerRuntime.js";
import type { MemoryProfile } from "../sqlite/memoryProfile.js";

/** Operations are serialized by the cache lock first, so a pool owner that
 * outlasts this is a foreign context (or a page that never closed it). */
export const ENGINE_POOL_WAIT_MS = 5_000;

export function engineStorageDeps(
	sqlite: LoadedSqlite,
	profile: MemoryProfile,
): SqlStorageDeps<SqlRawDatabase> {
	return workerStorageDeps(sqlite, ENGINE_POOL_WAIT_MS, profile.tempStore);
}
