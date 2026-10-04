import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";
import { type SqlBind, type SqlDatabaseOptions, type SqlExecResult, type SqlRow, type SqlRuntimeInfo, type SqlStatement, type SqlStorage, type SqlTransactionResult } from "./types.js";
export interface SqlWorkerLike {
    postMessage(message: SqlWorkerRequest): void;
    terminate(): void;
    addEventListener(type: "message", listener: (event: MessageEvent<SqlWorkerResponse>) => void): void;
    addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
    addEventListener(type: "messageerror", listener: (event: MessageEvent<unknown>) => void): void;
}
export type SqlWorkerFactory = () => SqlWorkerLike;
/** A statement compiled once in the Worker and run many times. */
export interface SqlPreparedStatement {
    run(bind?: SqlBind): Promise<SqlExecResult>;
    all<R extends SqlRow = SqlRow>(bind?: SqlBind): Promise<R[]>;
    finalize(): Promise<void>;
}
export interface SqlDatabase {
    readonly name: string;
    /** Where the database actually lives — OPFS, or memory and why. */
    readonly storage: SqlStorage;
    /** Run one or more statements (bind applies to the first). */
    exec(sql: string, bind?: SqlBind): Promise<SqlExecResult>;
    /** Rows of a single statement. */
    query<R extends SqlRow = SqlRow>(sql: string, bind?: SqlBind): Promise<R[]>;
    /** All statements in one BEGIN IMMEDIATE … COMMIT; any failure rolls back all. */
    transaction(statements: ReadonlyArray<SqlStatement>): Promise<SqlTransactionResult>;
    /** Bulk load: prepare once, step per row, one transaction. */
    executeMany(sql: string, rows: ReadonlyArray<SqlBind>): Promise<SqlExecResult>;
    prepare(sql: string): Promise<SqlPreparedStatement>;
    runtimeInfo(): Promise<SqlRuntimeInfo>;
    /** Close the connection, release the OPFS pool and end the Worker. */
    close(): Promise<void>;
}
export interface OpenSqlDatabaseOptions {
    readonly workerFactory?: SqlWorkerFactory;
}
/**
 * Open a named SQLite database in the library's Worker: OPFS (opfs-sahpool)
 * with the device memory profile applied, FTS5, JSON1 and sqlite-vector on the
 * same connection. Check `storage` to see whether it fell back to memory.
 */
export declare function openSqlDatabase(options: SqlDatabaseOptions, { workerFactory }?: OpenSqlDatabaseOptions): Promise<SqlDatabase>;
//# sourceMappingURL=client.d.ts.map