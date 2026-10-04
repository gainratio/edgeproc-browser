import type { SqlEngine } from "./engine.js";
import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";
import { type SqlDatabaseOptions } from "./types.js";
export interface OpenedSqlEngine {
    readonly engine: SqlEngine;
    /** Release whatever the open acquired (the OPFS owner lock); resolves once free. */
    release(): Promise<void>;
}
export type SqlEngineOpener = (options: SqlDatabaseOptions) => Promise<OpenedSqlEngine>;
export declare function createSqlWorkerHandler(open: SqlEngineOpener): (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>;
//# sourceMappingURL=handler.d.ts.map