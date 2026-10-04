import type { MemoryProfile, MemoryProfileSetting } from "../sqlite/memoryProfile.js";
/** A value SQLite returns in a row. BLOBs come back as Uint8Array. */
export type SqlValue = null | number | bigint | string | Uint8Array;
/**
 * A value you may bind. Typed arrays (e.g. a Float32Array embedding) and
 * ArrayBuffers are bound as their raw bytes, which is what sqlite-vector reads.
 */
export type SqlBindValue = SqlValue | boolean | ArrayBuffer | Float32Array | Float64Array | Int8Array;
/** Positional (`?`) or named (`:name`, `$name`, `@name`) parameters. */
export type SqlBind = ReadonlyArray<SqlBindValue> | Readonly<Record<string, SqlBindValue>>;
export type SqlRow = Readonly<Record<string, SqlValue>>;
/** One statement inside {@link SqlDatabase.transaction}. */
export type SqlStatement = {
    readonly sql: string;
    readonly bind?: SqlBind;
}
/** executemany: prepare once, step once per bind row. */
 | {
    readonly sql: string;
    readonly rows: ReadonlyArray<SqlBind>;
};
export interface SqlExecResult {
    /** Rows inserted, updated or deleted by this call. */
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
}
export interface SqlTransactionResult {
    readonly changes: number;
    /** Rows each statement produced (SELECT or RETURNING), in order. */
    readonly results: ReadonlyArray<ReadonlyArray<SqlRow>>;
}
/** Why a persistent database was opened in memory instead. */
export type SqlFallbackReason = 
/** OPFS itself is unavailable (private browsing, old browser, quota). */
"opfs-unavailable"
/** Another tab or Worker owns this database's OPFS pool. */
 | "pool-in-use";
/** Where the database actually lives. Check this; never assume OPFS. */
export type SqlStorage = {
    readonly persistence: "opfs";
    /** The opfs-sahpool VFS name (its OPFS directory is `.${pool}`). */
    readonly pool: string;
    readonly file: string;
} | {
    readonly persistence: "memory";
    readonly reason: "requested" | SqlFallbackReason;
    readonly detail?: string;
};
export interface SqlDatabaseOptions {
    /** Stable application name. Hashed into the OPFS pool and file names. */
    readonly name: string;
    /** Default "opfs". "memory" is for tests and tiny scratch databases. */
    readonly persistence?: "opfs" | "memory";
    /**
     * What to do when OPFS cannot be used. Default "none": fail closed with
     * {@link SqlStorageUnavailableError}. "memory" opens an in-memory database
     * and reports why in {@link SqlStorage} — only for small data you can
     * rebuild on every boot.
     */
    readonly fallback?: "none" | "memory";
    /** SQLite page cache / heap limits. Default "auto" (sized to the device). */
    readonly memoryProfile?: MemoryProfileSetting;
}
export interface SqlRuntimeInfo {
    readonly sqliteVersion: string;
    readonly vectorVersion: string;
    readonly fts5: boolean;
    readonly json1: boolean;
    readonly memoryProfile: MemoryProfile;
    readonly storage: SqlStorage;
}
/** OPFS could not be used and no fallback was allowed. */
export declare class SqlStorageUnavailableError extends Error {
    readonly reason: SqlFallbackReason;
    constructor(reason: SqlFallbackReason, message: string);
}
//# sourceMappingURL=types.d.ts.map