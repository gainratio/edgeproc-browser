/// <reference lib="webworker" />
// The SQL Worker entry: load the pinned SQLite build, open the named database
// (OPFS via opfs-sahpool, owner-locked; memory only as a reported fallback),
// apply the device memory profile, and answer the client's requests.
import { resolveMemoryProfile } from "../sqlite/memoryProfile.js";
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { configureInlineOpfsProxy } from "../vector/sqlite/opfsAsyncProxy.js";
import { createSqlConnectionControl } from "./control.js";
import { SqlEngine } from "./engine.js";
import { createSqlWorkerHandler } from "./handler.js";
import { asLegacySahPool, createJournalRecovery, migrateLegacySahPool, opfsPoolExists, } from "./legacy.js";
import { openSqlStorage, ownerLockWaitMs } from "./open.js";
import { createSqlSerializer } from "./serializer.js";
const handle = createSqlWorkerHandler(openEngine);
self.onmessage = (event) => {
    void handle(event.data).then((response) => self.postMessage(response));
};
async function openEngine(options, context) {
    configureInlineOpfsProxy();
    const sqlite = await sqlite3InitModule({
        print: () => undefined,
        printErr: (...args) => console.error(...args),
    });
    const lockWaitMs = ownerLockWaitMs(resolveMemoryProfile(options.memoryProfile ?? "auto").tier);
    const opened = await openSqlStorage({
        openMemory: () => new sqlite.oo1.DB(":memory:"),
        installPool: async (name) => (await sqlite.installOpfsSAHPoolVfs({
            name,
            forceReinitIfPreviouslyFailed: true,
        })),
        locks: navigatorLocks(),
        warn: (message) => console.warn(message),
        lockWaitMs,
    }, options, context);
    try {
        const engine = new SqlEngine(opened.raw, {
            storage: opened.storage,
            memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
            serializer: createSqlSerializer(sqlite),
            control: createSqlConnectionControl(sqlite),
        });
        return {
            engine,
            release: opened.release,
            migrateLegacy: legacyMigrator(sqlite, opened.storage, engine, lockWaitMs),
        };
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
function navigatorLocks() {
    return navigator.locks;
}
/** Legacy opfs-sahpool migration on this Worker's module and connection. */
function legacyMigrator(sqlite, storage, engine, lockWaitMs) {
    const recover = createJournalRecovery(sqlite);
    return (request) => migrateLegacySahPool({
        locks: navigatorLocks(),
        lockWaitMs,
        ownPool: storage.persistence === "opfs" ? storage.pool : undefined,
        poolExists: async (pool) => opfsPoolExists(pool, await navigator.storage.getDirectory()),
        installPool: async (name) => asLegacySahPool(await sqlite.installOpfsSAHPoolVfs({
            name,
            forceReinitIfPreviouslyFailed: true,
        })),
        recover,
        importDatabase: (bytes, options) => engine.importDatabase(bytes, options),
    }, request);
}
//# sourceMappingURL=worker.js.map