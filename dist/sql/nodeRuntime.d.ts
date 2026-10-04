import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { type SqlConnectionControl } from "./control.js";
import type { SqlRawDatabase } from "./engine.js";
import { type SqlSerializer } from "./serializer.js";
type SqliteModule = Awaited<ReturnType<typeof sqlite3InitModule>>;
export interface InProcessSqlite {
    readonly module: SqliteModule;
    readonly serializer: SqlSerializer;
    readonly control: SqlConnectionControl;
    openMemory(): SqlRawDatabase;
}
/**
 * Initialise the pinned build from `wasm`. With no `location`, sqlite3.mjs's
 * OPFS installers fail and warn ("Ignoring inability to install …"); there
 * is no OPFS here, so those two warnings are dropped through upstream's own
 * config hook (globalThis.sqlite3ApiConfig, which the loader consumes and
 * deletes). Every other warning still reaches console.warn.
 */
export declare function initInProcessSqlite(wasm: Uint8Array): Promise<InProcessSqlite>;
export {};
//# sourceMappingURL=nodeRuntime.d.ts.map