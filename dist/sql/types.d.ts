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
/** What the incoming database must be before {@link SqlDatabase.importDatabase} replaces yours. */
export interface SqlExpectedSchema {
    /** `PRAGMA application_id` the file must carry (your app's 32-bit magic). */
    readonly applicationId?: number;
    /** `PRAGMA user_version`: an exact version, or an inclusive range. */
    readonly userVersion?: number | {
        readonly min?: number;
        readonly max?: number;
    };
    /**
     * Read-only SQL run against the INCOMING file (never yours). Each must
     * return a first row whose first column is 1, e.g.
     * `SELECT count(*) = 1 FROM sqlite_schema WHERE name = 'charts'`.
     */
    readonly checks?: ReadonlyArray<string>;
}
export interface SqlImportOptions {
    readonly expectedSchema?: SqlExpectedSchema;
    /** Refuse larger files before reading them. Default 256 MiB. */
    readonly maxBytes?: number;
    /**
     * Triggers and views run SQL the FILE chose, on your connection, later.
     * Refused unless you set this (and trust where the file came from).
     */
    readonly allowTriggersAndViews?: boolean;
    /** Virtual-table modules the file may use. Default `["fts5"]`. */
    readonly virtualTableModules?: ReadonlyArray<string>;
}
export interface SqlImportResult {
    readonly byteLength: number;
    readonly applicationId: number;
    readonly userVersion: number;
}
/** Why an import was refused. Nothing was changed when you see one. */
export type SqlImportRejection = 
/** No SQLite header: not a database at all. */
"not-sqlite"
/**
 * A SQLite header, but the file is truncated, fails integrity_check, or
 * a schema row holds more than one statement.
 */
 | "corrupt"
/** `application_id` is not the one you expected. */
 | "foreign-application"
/** `user_version` is outside what you support. */
 | "unsupported-version"
/** A trigger/view you did not allow, or an unlisted virtual-table module. */
 | "unsafe-schema"
/** One of your `checks` did not return 1 (or failed). */
 | "check-failed"
/** Larger than `maxBytes`. */
 | "too-large";
/** The incoming file was refused during validation; your database is unchanged. */
export declare class SqlImportRejectedError extends Error {
    readonly reason: SqlImportRejection;
    constructor(reason: SqlImportRejection, message: string);
}
/** A database another build kept in an opfs-sahpool, and how to move it. */
export interface MigrateLegacySahPoolOptions {
    /** The legacy pool's VFS name (its OPFS directory is `.${fromPool}`). */
    readonly fromPool: string;
    /** The database's name inside that pool, e.g. "/kyc.sqlite3". */
    readonly fromFile: string;
    /** Delete the legacy pool once the import has committed. Default false. */
    readonly removeLegacy?: boolean;
    /** Web Lock held while the pool is read. Default `${fromPool}-owner`. */
    readonly lockName?: string;
    /** Validation for the incoming file (schema checks, triggers, size). */
    readonly importOptions?: SqlImportOptions;
}
export type LegacySahPoolMigration = {
    readonly status: "migrated";
    readonly result: SqlImportResult;
    /** A rollback journal was present and SQLite played it back. */
    readonly recoveredJournal: boolean;
    /**
     * "removed": you asked, and the pool is gone. "shared": you asked, but
     * the pool holds other files too, so nothing was deleted. "kept":
     * you did not ask (or removal left the directory behind).
     */
    readonly legacy: "removed" | "kept" | "shared";
}
/** No such pool, or no such file in it. Nothing was created. */
 | {
    readonly status: "absent";
}
/** Another context holds the pool or the lock. Nothing changed; retry later. */
 | {
    readonly status: "in-use";
};
/**
 * SQLite ended the interactive transaction itself (a RAISE(ROLLBACK), or an
 * error such as SQLITE_FULL, IOERR or BUSY that rolls the whole transaction
 * back). Its writes are gone, and nothing more runs in it.
 */
export declare class SqlTransactionEndedError extends Error {
    constructor(message?: string);
}
//# sourceMappingURL=types.d.ts.map