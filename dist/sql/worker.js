/// <reference lib="webworker" />
// The SQL Worker entry: load the pinned SQLite build, open the named database
// (OPFS via opfs-sahpool, owner-locked; memory only as a reported fallback),
// apply the device memory profile, and answer the client's requests.
import { resolveMemoryProfile } from "../sqlite/memoryProfile.js";
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { configureInlineOpfsProxy } from "../vector/sqlite/opfsAsyncProxy.js";
import { SqlEngine } from "./engine.js";
import { createSqlWorkerHandler } from "./handler.js";
import { openSqlStorage } from "./open.js";
const LOCK_WAIT_MS = 2_000;
const handle = createSqlWorkerHandler(openEngine);
self.onmessage = (event) => {
    void handle(event.data).then((response) => self.postMessage(response));
};
async function openEngine(options) {
    configureInlineOpfsProxy();
    const sqlite = await sqlite3InitModule({
        print: () => undefined,
        printErr: (...args) => console.error(...args),
    });
    const opened = await openSqlStorage({
        openMemory: () => new sqlite.oo1.DB(":memory:"),
        installPool: async (name) => (await sqlite.installOpfsSAHPoolVfs({
            name,
            forceReinitIfPreviouslyFailed: true,
        })),
        locks: navigator.locks,
        warn: (message) => console.warn(message),
        lockWaitMs: LOCK_WAIT_MS,
    }, options);
    try {
        const engine = new SqlEngine(opened.raw, {
            storage: opened.storage,
            memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
        });
        return { engine, release: opened.release };
    }
    catch (error) {
        try {
            opened.raw.close();
        }
        finally {
            opened.release();
        }
        throw error;
    }
}
//# sourceMappingURL=worker.js.map