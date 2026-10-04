import type { SqlBind, SqlDatabaseOptions, SqlFallbackReason, SqlStatement } from "./types.js";
type WithId<T> = T & {
    readonly id: number;
};
export type SqlWorkerRequest = WithId<{
    readonly operation: "open";
    readonly options: SqlDatabaseOptions;
} | {
    readonly operation: "exec";
    readonly sql: string;
    readonly bind?: SqlBind;
} | {
    readonly operation: "query";
    readonly sql: string;
    readonly bind?: SqlBind;
} | {
    readonly operation: "transaction";
    readonly statements: ReadonlyArray<SqlStatement>;
} | {
    readonly operation: "execute-many";
    readonly sql: string;
    readonly rows: ReadonlyArray<SqlBind>;
} | {
    readonly operation: "prepare";
    readonly sql: string;
} | {
    readonly operation: "run-prepared" | "all-prepared";
    readonly statement: number;
    readonly bind?: SqlBind;
} | {
    readonly operation: "finalize";
    readonly statement: number;
} | {
    readonly operation: "runtime-info";
} | {
    readonly operation: "close";
}>;
export interface SqlWorkerError {
    readonly name: string;
    readonly message: string;
    readonly reason?: SqlFallbackReason;
}
export type SqlWorkerResponse = {
    readonly id: number;
    readonly ok: true;
    readonly value: unknown;
} | {
    readonly id: number;
    readonly ok: false;
    readonly error: SqlWorkerError;
};
export {};
//# sourceMappingURL=protocol.d.ts.map