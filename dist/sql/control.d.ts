import type { SqlRawDatabase } from "./engine.js";
type Pointer = number | bigint;
/** The slice of the sqlite-wasm module this needs. */
export interface SqlControlModule {
    readonly capi: {
        readonly SQLITE_DENY: number;
        readonly SQLITE_OK: number;
        readonly SQLITE_SAVEPOINT: number;
        readonly SQLITE_TRANSACTION: number;
        sqlite3_get_autocommit(database: Pointer): number;
        sqlite3_set_authorizer(database: Pointer, authorizer: ((user: Pointer, action: number) => number) | 0, user: 0): number;
    };
}
export interface SqlConnectionControl {
    /** Is a transaction open on `raw` (sqlite3_get_autocommit == 0)? */
    inTransaction(raw: SqlRawDatabase): boolean;
    /** Run `work` with every transaction-control statement denied. */
    withoutTransactionControl<T>(raw: SqlRawDatabase, work: () => T): T;
}
/** Narrow an initialised sqlite-wasm module to the slice this needs. */
export declare function isSqlControlModule(module: object): module is SqlControlModule;
export declare function createSqlConnectionControl(module: object): SqlConnectionControl;
export {};
//# sourceMappingURL=control.d.ts.map