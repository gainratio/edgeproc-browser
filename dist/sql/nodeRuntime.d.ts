import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import type { SqlRawDatabase } from "./engine.js";
import { type SqlSerializer } from "./serializer.js";
type SqliteModule = Awaited<ReturnType<typeof sqlite3InitModule>>;
export interface InProcessSqlite {
    readonly module: SqliteModule;
    readonly serializer: SqlSerializer;
    openMemory(): SqlRawDatabase;
}
/**
 * Initialise the pinned build from `wasm`. sqlite3.mjs auto-installs its OPFS
 * VFSes when it sees a `location`; the shim below tells it not to (there is no
 * OPFS here) and is removed again, one initialisation at a time.
 */
export declare function initInProcessSqlite(wasm: Uint8Array): Promise<InProcessSqlite>;
export {};
//# sourceMappingURL=nodeRuntime.d.ts.map