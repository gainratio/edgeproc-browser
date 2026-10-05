import type { SqlRawDatabase } from "../sql/engine.js";
import type { SqlStorageDeps } from "../sql/open.js";
import { type LoadedSqlite } from "../sql/workerRuntime.js";
import type { MemoryProfile } from "../sqlite/memoryProfile.js";
/** Operations are serialized by the cache lock first, so a pool owner that
 * outlasts this is a foreign context (or a page that never closed it). */
export declare const ENGINE_POOL_WAIT_MS = 5000;
export declare function engineStorageDeps(sqlite: LoadedSqlite, profile: MemoryProfile): SqlStorageDeps<SqlRawDatabase>;
//# sourceMappingURL=storageDeps.d.ts.map