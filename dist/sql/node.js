/// <reference types="node" />
// @gainratio/browser/sql/node — the SQL seam for Node test suites. The SAME
// pinned SQLite build (3.53.4 + FTS5 + JSON1 + sqlite-vector 1.1.2), the same
// client and the same Worker-side handler as the browser, run in-process.
// Every request and response is structured-cloned as postMessage would clone
// it, so a test sees what the browser Worker would. Storage is memory only.
import { readFile } from "node:fs/promises";
import { resolveMemoryProfile, } from "../sqlite/memoryProfile.js";
import { openSqlDatabase, } from "./client.js";
import { SqlEngine } from "./engine.js";
import { createSqlWorkerHandler } from "./handler.js";
import { initInProcessSqlite } from "./nodeRuntime.js";
let wasmBytes;
/**
 * Open a new in-memory database on the library's pinned SQLite build, in
 * this process. Same {@link SqlDatabase} API as `openSqlDatabase`; OPFS-only
 * calls (legacy pool migration) reject.
 */
export async function openNodeSqlDatabase(options) {
    // One wasm instance per database, as in the browser (one Worker each):
    // SQLite's heap limits are per instance, so profiles cannot leak across.
    const sqlite = await initInProcessSqlite(await loadWasm());
    const handle = createSqlWorkerHandler(async (opened) => ({
        engine: new SqlEngine(sqlite.openMemory(), {
            storage: { persistence: "memory", reason: "requested" },
            memoryProfile: resolveMemoryProfile(opened.memoryProfile ?? "auto"),
            serializer: sqlite.serializer,
        }),
        release: async () => undefined,
    }));
    return openSqlDatabase({
        name: options.name,
        persistence: "memory",
        ...(options.memoryProfile === undefined
            ? {}
            : { memoryProfile: options.memoryProfile }),
    }, { workerFactory: () => new InProcessSqlWorker(handle) });
}
function loadWasm() {
    wasmBytes ??= readFile(new URL("../vector/sqlite/assets/sqlite3.wasm", import.meta.url)).then((bytes) => new Uint8Array(bytes));
    return wasmBytes;
}
/** A Worker stand-in: same handler, same structured clone, no thread. */
class InProcessSqlWorker {
    #handle;
    #listeners = [];
    #terminated = false;
    constructor(handle) {
        this.#handle = handle;
    }
    postMessage(request) {
        void this.#handle(structuredClone(request)).then((response) => {
            if (this.#terminated)
                return;
            const event = { data: structuredClone(response) };
            for (const listener of this.#listeners)
                listener(event);
        });
    }
    addEventListener(type, listener) {
        if (type === "message") {
            this.#listeners.push(listener);
        }
    }
    terminate() {
        this.#terminated = true;
    }
}
//# sourceMappingURL=node.js.map