import type { SqlRawDatabase } from "./engine.js";
/** The slice of the sqlite-wasm module serialization needs. */
export interface SqlSerializationModule {
    readonly oo1: {
        readonly DB: new (filename: string) => unknown;
    };
    readonly capi: {
        readonly SQLITE_OK: number;
        sqlite3_deserialize(database: number | bigint, schema: string, bytes: number | bigint, size: bigint, bufferSize: bigint, flags: number): number;
        sqlite3_js_db_export(database: number | bigint, schema?: string): Uint8Array;
        sqlite3_errstr(code: number): string;
        sqlite3_complete(sql: string): number;
        sqlite3_drop_modules(database: number | bigint, keep: number | bigint): number;
    };
    readonly wasm: {
        allocFromTypedArray(bytes: Uint8Array): number | bigint;
        dealloc(pointer: number | bigint): void;
        scopedAllocPush(): unknown;
        scopedAllocPop(scope: unknown): void;
        scopedAllocMainArgv(list: ReadonlyArray<string>): number | bigint;
    };
}
export interface SqlSerializer {
    /** The `main` schema of `raw` as a SQLite file. */
    serialize(raw: SqlRawDatabase): Uint8Array;
    /** sqlite3_complete: does `sql` end with a complete statement? */
    isComplete(sql: string): boolean;
    /** sqlite3_drop_modules: unregister every module not in `keep`. */
    keepOnlyModules(raw: SqlRawDatabase, keep: ReadonlyArray<string>): void;
    /** A fresh, empty in-memory connection. */
    scratch(): SqlRawDatabase;
    /**
     * Load a copy of `bytes` into `schema` of `raw` (`main`, or an ATTACHed
     * schema); fixed-size, and read-only when `readonly`. Returns the release
     * for the copy: call it only after the schema is closed or DETACHed.
     */
    deserialize(raw: SqlRawDatabase, schema: string, bytes: Uint8Array, readonly: boolean): () => void;
}
export declare function createSqlSerializer(sqlite: SqlSerializationModule): SqlSerializer;
//# sourceMappingURL=serializer.d.ts.map