import type { SqlEngine } from "./engine.js";
import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";
import { type LegacySahPoolMigration, type MigrateLegacySahPoolOptions, type SqlDatabaseOptions } from "./types.js";
export interface OpenedSqlEngine {
    readonly engine: SqlEngine;
    /** Release whatever the open acquired (the OPFS owner lock); resolves once free. */
    release(): Promise<void>;
    /** Only a browser Worker (OPFS) can read a legacy opfs-sahpool. */
    migrateLegacy?(options: MigrateLegacySahPoolOptions): Promise<LegacySahPoolMigration>;
}
export type SqlEngineOpener = (options: SqlDatabaseOptions) => Promise<OpenedSqlEngine>;
export declare function createSqlWorkerHandler(open: SqlEngineOpener): (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>;
//# sourceMappingURL=handler.d.ts.map