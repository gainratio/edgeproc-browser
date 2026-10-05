// How the engine Worker opens its chunk-cache pool: the library's SQL seam
// (openSqlStorage), with the pool topped up for the SAME memory profile the
// chunk database applies. temp_store=FILE (the "minimal" tier) needs slots
// for temp files; a wrong profile here is how a pool runs out of slots.
import { workerStorageDeps } from "../sql/workerRuntime.js";
/** Operations are serialized by the cache lock first, so a pool owner that
 * outlasts this is a foreign context (or a page that never closed it). */
export const ENGINE_POOL_WAIT_MS = 5_000;
export function engineStorageDeps(sqlite, profile) {
    return workerStorageDeps(sqlite, ENGINE_POOL_WAIT_MS, profile.tempStore);
}
//# sourceMappingURL=storageDeps.js.map