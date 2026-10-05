// The pinned sqlite-wasm module, initialised for an in-process (Node) host.
// Free of node: imports — the caller hands over the wasm bytes — so the only
// Node-only module in dist/sql stays node.js.
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { createSqlConnectionControl, } from "./control.js";
import { createSqlSerializer } from "./serializer.js";
let queue = Promise.resolve();
/**
 * Initialise the pinned build from `wasm`. With no `location`, sqlite3.mjs's
 * OPFS installers fail and warn ("Ignoring inability to install …"); there
 * is no OPFS here, so those two warnings are dropped through upstream's own
 * config hook (globalThis.sqlite3ApiConfig, which the loader consumes and
 * deletes). Every other warning still reaches console.warn.
 */
export function initInProcessSqlite(wasm) {
    const load = async () => {
        const host = globalThis;
        host.sqlite3ApiConfig = { warn: warnUnlessOpfsInstall };
        try {
            const sqlite = await sqlite3InitModule({
                wasmBinary: wasm,
                print: () => undefined,
                printErr: () => undefined,
            });
            return {
                module: sqlite,
                serializer: createSqlSerializer(sqlite),
                control: createSqlConnectionControl(sqlite),
                openMemory: () => new sqlite.oo1.DB(":memory:"),
            };
        }
        finally {
            // Consumed and deleted by the loader; never left behind on failure.
            delete host.sqlite3ApiConfig;
        }
    };
    const next = queue.then(load, load);
    queue = next.catch(() => undefined);
    return next;
}
function warnUnlessOpfsInstall(...args) {
    if (/^Ignoring inability to install/.test(String(args[0])))
        return;
    console.warn(...args);
}
//# sourceMappingURL=nodeRuntime.js.map