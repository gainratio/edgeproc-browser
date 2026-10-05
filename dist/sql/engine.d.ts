import { type MemoryProfile } from "../sqlite/memoryProfile.js";
import type { SqlConnectionControl } from "./control.js";
import type { SqlSerializer } from "./serializer.js";
import type { SqlBind, SqlExecResult, SqlImportOptions, SqlImportResult, SqlRow, SqlRuntimeInfo, SqlStatement, SqlStorage, SqlTransactionResult } from "./types.js";
export declare const PINNED_SQLITE_VERSION = "3.53.4";
export declare const PINNED_VECTOR_VERSION = "1.1.2";
type RawBind = ReadonlyArray<unknown> | Readonly<Record<string, unknown>>;
/** The slice of an OO1 prepared statement the engine uses. */
export interface SqlRawStatement {
    bind(values: RawBind): unknown;
    step(): boolean;
    get(target: Record<string, unknown>): Record<string, unknown>;
    reset(clearBindings?: boolean): unknown;
    finalize(): unknown;
}
/** The slice of an OO1 database handle the engine uses. */
export interface SqlRawDatabase {
    /** The native sqlite3* handle (sqlite-wasm OO1 exposes it). */
    readonly pointer?: number | bigint;
    exec(options: {
        readonly sql: string;
        readonly bind?: RawBind;
    }): unknown;
    selectObjects(sql: string, bind?: RawBind): Array<Record<string, unknown>>;
    prepare(sql: string): SqlRawStatement;
    transaction<T>(qualifier: "IMMEDIATE", callback: () => T): T;
    close(): void;
}
export interface SqlEngineOptions {
    readonly storage: SqlStorage;
    readonly memoryProfile: MemoryProfile;
    /** SQLite's own (de)serialization; required for export and import. */
    readonly serializer?: SqlSerializer;
    /** Transaction state + control refusal; required for begin(). */
    readonly control?: SqlConnectionControl;
}
export declare class SqlEngine {
    #private;
    constructor(raw: SqlRawDatabase, options: SqlEngineOptions);
    exec(sql: string, bind?: SqlBind): SqlExecResult;
    query(sql: string, bind?: SqlBind): SqlRow[];
    transaction(statements: ReadonlyArray<SqlStatement>): SqlTransactionResult;
    /**
     * In-Worker only (not on the message protocol): run `work` inside one
     * BEGIN IMMEDIATE … COMMIT, so a read, a JS check and a write commit
     * together; a throw rolls all of it back. `work` may call exec/query.
     */
    immediate<T>(work: () => T): T;
    executeMany(sql: string, rows: ReadonlyArray<SqlBind>): SqlExecResult;
    prepare(sql: string): number;
    runPrepared(id: number, bind?: SqlBind): SqlExecResult;
    allPrepared(id: number, bind?: SqlBind): SqlRow[];
    finalize(id: number): void;
    /** Start an interactive transaction; the client holds its lock until it ends. */
    begin(): void;
    /** exec inside the interactive transaction; refused once it has ended. */
    txExec(sql: string, bind?: SqlBind): SqlExecResult;
    /** query inside the interactive transaction; refused once it has ended. */
    txQuery(sql: string, bind?: SqlBind): SqlRow[];
    /** COMMIT, unless SQLite already ended the transaction (then refuse). */
    commit(): void;
    /** ROLLBACK if a transaction is open; nothing (and no error) otherwise. */
    rollback(): void;
    /** The whole database as a SQLite file (sqlite3_serialize). */
    exportDatabase(): Uint8Array;
    /** Validate `bytes`, then replace this database with it in one transaction. */
    importDatabase(bytes: Uint8Array, options?: SqlImportOptions): SqlImportResult;
    runtimeInfo(): SqlRuntimeInfo;
    close(): void;
}
export {};
//# sourceMappingURL=engine.d.ts.map