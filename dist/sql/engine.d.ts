import { type MemoryProfile } from "../sqlite/memoryProfile.js";
import type { SqlBind, SqlExecResult, SqlRow, SqlRuntimeInfo, SqlStatement, SqlStorage, SqlTransactionResult } from "./types.js";
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
}
export declare class SqlEngine {
    #private;
    constructor(raw: SqlRawDatabase, options: SqlEngineOptions);
    exec(sql: string, bind?: SqlBind): SqlExecResult;
    query(sql: string, bind?: SqlBind): SqlRow[];
    transaction(statements: ReadonlyArray<SqlStatement>): SqlTransactionResult;
    executeMany(sql: string, rows: ReadonlyArray<SqlBind>): SqlExecResult;
    prepare(sql: string): number;
    runPrepared(id: number, bind?: SqlBind): SqlExecResult;
    allPrepared(id: number, bind?: SqlBind): SqlRow[];
    finalize(id: number): void;
    runtimeInfo(): SqlRuntimeInfo;
    close(): void;
}
export {};
//# sourceMappingURL=engine.d.ts.map