import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";
import { type LegacySahPoolMigration, type MigrateLegacySahPoolOptions, type SqlBind, type SqlDatabaseOptions, type SqlExecResult, type SqlImportOptions, type SqlImportResult, type SqlRow, type SqlRuntimeInfo, type SqlStatement, type SqlStorage, type SqlTransactionResult } from "./types.js";
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
/**
 * The handle an interactive transaction's callback gets. Its calls run inside
 * the transaction; the handle stops working once the callback settles.
 */
export interface SqlTransaction {
    exec(sql: string, bind?: SqlBind): Promise<SqlExecResult>;
    query<R extends SqlRow = SqlRow>(sql: string, bind?: SqlBind): Promise<R[]>;
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
    /**
     * Interactive: BEGIN IMMEDIATE, run `work` (read, decide in JS, write
     * through `tx`), COMMIT; a throw or a failed COMMIT rolls back and rejects
     * with that error. Every other call on this handle waits until it ends, so
     * nothing interleaves. Inside `work`, use `tx` — awaiting a call on `db`
     * there waits for the transaction it is part of, and never resolves.
     */
    transaction<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
    /** Bulk load: prepare once, step per row, one transaction. */
    executeMany(sql: string, rows: ReadonlyArray<SqlBind>): Promise<SqlExecResult>;
    prepare(sql: string): Promise<SqlPreparedStatement>;
    /** The whole database as a SQLite file (sqlite3_serialize). */
    exportDatabase(): Promise<Uint8Array>;
    /**
     * Validate `bytes` (header, integrity_check, your expectations), then
     * replace this database with it in one transaction. On any failure the
     * database is unchanged.
     */
    importDatabase(bytes: Uint8Array, options?: SqlImportOptions): Promise<SqlImportResult>;
    /**
     * Move a database another build kept in an opfs-sahpool into this one:
     * hold that pool exclusively, let SQLite recover a hot journal, import the
     * result atomically (as {@link importDatabase}), then remove the legacy
     * pool only if you asked. Browser Worker on OPFS only.
     */
    migrateLegacySahPool(options: MigrateLegacySahPoolOptions): Promise<LegacySahPoolMigration>;
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
/**
 * Export a database: an open handle, or a name — opened on OPFS (never a
 * memory fallback) under its owner lock, exported, closed.
 */
export declare function exportDatabase(target: SqlDatabase | string, options?: OpenSqlDatabaseOptions): Promise<Uint8Array>;
/**
 * Replace a database with `bytes`: an open handle, or a name. By name it is
 * opened on OPFS under the owner Web Lock, so no other tab or Worker can
 * write while the import runs; if one already has it open, this fails
 * closed with {@link SqlStorageUnavailableError} ("pool-in-use").
 */
export declare function importDatabase(target: SqlDatabase | string, bytes: Uint8Array, options?: SqlImportOptions & OpenSqlDatabaseOptions): Promise<SqlImportResult>;
/**
 * Move a legacy opfs-sahpool database into `to` (an open handle, or a name
 * opened on OPFS under its owner lock, never a memory fallback). See
 * {@link SqlDatabase.migrateLegacySahPool}.
 */
export declare function migrateLegacySahPool(options: MigrateLegacySahPoolOptions & {
    readonly to: SqlDatabase | string;
}, openOptions?: OpenSqlDatabaseOptions): Promise<LegacySahPoolMigration>;
//# sourceMappingURL=client.d.ts.map