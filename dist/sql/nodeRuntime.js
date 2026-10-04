// The pinned sqlite-wasm module, initialised for an in-process (Node) host.
// Free of node: imports — the caller hands over the wasm bytes — so the only
// Node-only module in dist/sql stays node.js.
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { createSqlSerializer } from "./serializer.js";
let queue = Promise.resolve();
/**
 * Initialise the pinned build from `wasm`. sqlite3.mjs auto-installs its OPFS
 * VFSes when it sees a `location`; the shim below tells it not to (there is no
 * OPFS here) and is removed again, one initialisation at a time.
 */
export function initInProcessSqlite(wasm) {
    const load = async () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, "location");
        Object.defineProperty(globalThis, "location", {
            configurable: true,
            value: { href: "https://edgeproc.invalid/?opfs-disable&opfs-wl-disable" },
        });
        try {
            const sqlite = await sqlite3InitModule({
                wasmBinary: wasm,
                print: () => undefined,
                printErr: () => undefined,
            });
            return {
                module: sqlite,
                serializer: createSqlSerializer(sqlite),
                openMemory: () => new sqlite.oo1.DB(":memory:"),
            };
        }
        finally {
            if (original === undefined) {
                delete globalThis.location;
            }
            else {
                Object.defineProperty(globalThis, "location", original);
            }
        }
    };
    const next = queue.then(load, load);
    queue = next.catch(() => undefined);
    return next;
}
//# sourceMappingURL=nodeRuntime.js.map