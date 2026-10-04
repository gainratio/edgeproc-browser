/// <reference lib="webworker" />
// The SQL Worker entry: load the pinned SQLite build, open the named database
// (OPFS via opfs-sahpool, owner-locked; memory only as a reported fallback),
// apply the device memory profile, and answer the client's requests.
import { resolveMemoryProfile } from "../sqlite/memoryProfile.js";
import { SqlEngine } from "./engine.js";
import { createSqlWorkerHandler } from "./handler.js";
import { openSqlStorage, ownerLockWaitMs } from "./open.js";
import { createSqlSerializer } from "./serializer.js";
import { loadSqlite, workerStorageDeps } from "./workerRuntime.js";
const handle = createSqlWorkerHandler(openEngine);
self.onmessage = (event) => {
    void handle(event.data).then((response) => self.postMessage(response));
};
async function openEngine(options) {
    const sqlite = await loadSqlite();
    const opened = await openSqlStorage(workerStorageDeps(sqlite, ownerLockWaitMs(resolveMemoryProfile(options.memoryProfile ?? "auto").tier)), options);
    try {
        const engine = new SqlEngine(opened.raw, {
            storage: opened.storage,
            memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
            serializer: createSqlSerializer(sqlite),
        });
        return { engine, release: opened.release };
    }
    catch (error) {
        try {
            opened.raw.close();
        }
        finally {
            await opened.release();
        }
        throw error;
    }
}
//# sourceMappingURL=worker.js.map