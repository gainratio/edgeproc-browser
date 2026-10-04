import { type MemoryProfileSetting } from "./memoryProfile.js";
export type SqliteStateValue = Uint8Array;
export type SqliteStatePersistence = "memory" | "opfs";
export interface SqliteStateStoreOptions {
    readonly name: string;
    /** Applied only when a new database is initialized. */
    readonly initialSchemaVersion: number;
    readonly persistence?: SqliteStatePersistence;
    /** SQLite page cache and heap limits. Default "auto": sized to the device, conservative on iOS. */
    readonly memoryProfile?: MemoryProfileSetting;
    readonly maxImportBytes?: number;
}
export interface SqliteStateRow {
    readonly namespace: string;
    readonly key: string;
    readonly value: Uint8Array;
    readonly revision: number;
}
export type SqliteStateMutation = {
    readonly type: "put";
    readonly namespace: string;
    readonly key: string;
    readonly value: Uint8Array;
} | {
    readonly type: "delete";
    readonly namespace: string;
    readonly key: string;
};
export interface SqliteStateBatchOptions {
    readonly expectedEpoch?: number;
}
export interface SqliteStateBatchResult {
    readonly changed: number;
    readonly epoch: number;
}
export interface SqliteStateListOptions {
    readonly namespace: string;
    readonly prefix?: string;
    readonly afterKey?: string;
    readonly limit?: number;
}
export interface SqliteStateListPage {
    readonly rows: ReadonlyArray<SqliteStateRow>;
    readonly nextKey?: string;
}
export interface SqliteStateMigration {
    readonly fromVersion: number;
    readonly toVersion: number;
    readonly expectedEpoch?: number;
    readonly mutations: ReadonlyArray<SqliteStateMutation>;
}
export interface SqliteStateMigrationResult extends SqliteStateBatchResult {
    readonly schemaVersion: number;
}
export interface SqliteStateImportStage {
    readonly stageId: string;
    readonly schemaVersion: number;
    readonly epoch: number;
    readonly rowCount: number;
    readonly byteLength: number;
}
export interface SqliteStateImportResult extends SqliteStateBatchResult {
    readonly schemaVersion: number;
}
export interface SqliteStateIntegrityResult {
    readonly ok: true;
    readonly message: "ok";
}
export interface SqliteStateRuntimeInfo {
    readonly name: string;
    readonly sqliteVersion: string;
    readonly persistence: SqliteStatePersistence;
    readonly ownership: "isolated-worker" | "shared-opfs-web-locks";
    readonly schemaVersion: number;
    readonly epoch: number;
    readonly rowCount: number;
}
export type SqliteStateBindValue = string | number | null | Uint8Array;
/** Minimal private SQLite seam. It deliberately never crosses the public API. */
export interface SqliteStateDatabase {
    exec(sql: string, bind?: ReadonlyArray<SqliteStateBindValue>): void;
    selectObjects(sql: string, bind?: ReadonlyArray<SqliteStateBindValue>): ReadonlyArray<Readonly<Record<string, unknown>>>;
    transaction<T>(callback: () => T): T;
    close(): void;
}
export interface SqliteStateDatabaseHandle {
    readonly pointer: number | bigint;
    exec(options: {
        readonly sql: string;
        readonly bind?: ReadonlyArray<unknown>;
    }): unknown;
    selectObjects(sql: string, bind?: ReadonlyArray<unknown>): Array<Record<string, unknown>>;
    transaction<T>(callback: () => T): T;
    transaction<T>(qualifier: "IMMEDIATE", callback: () => T): T;
    close(): void;
}
export interface SqliteStateSnapshot {
    readonly schemaVersion: number;
    readonly epoch: number;
    readonly rows: ReadonlyArray<SqliteStateRow>;
}
export interface SqliteStateRuntime {
    readonly database: SqliteStateDatabase;
    exportBytes(): Uint8Array;
    readSnapshot(bytes: Uint8Array): SqliteStateSnapshot;
}
export declare class SqliteStateConflictError extends Error {
    readonly name = "SqliteStateConflictError";
}
export declare class SqliteStateSchemaError extends Error {
    readonly name = "SqliteStateSchemaError";
}
/**
 * Typed application-state operations over SQLite. SQL remains an implementation
 * detail so callers cannot accidentally couple themselves to the internal schema.
 */
export declare class SqliteStateStoreDatabase {
    #private;
    readonly name: string;
    constructor(options: SqliteStateStoreOptions, database: SqliteStateDatabase, runtime: SqliteStateRuntime, persistent?: boolean);
    get(namespace: string, key: string): Promise<SqliteStateRow | undefined>;
    list(options: SqliteStateListOptions): Promise<SqliteStateListPage>;
    put(namespace: string, key: string, value: Uint8Array, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    delete(namespace: string, key: string, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    batch(mutations: ReadonlyArray<SqliteStateMutation>, options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    migrate(migration: SqliteStateMigration): Promise<SqliteStateMigrationResult>;
    checkIntegrity(): Promise<SqliteStateIntegrityResult>;
    exportBytes(): Promise<Uint8Array>;
    stageImport(bytes: Uint8Array): Promise<SqliteStateImportStage>;
    discardImport(stageId: string): Promise<void>;
    commitImport(stageId: string, options?: SqliteStateBatchOptions): Promise<SqliteStateImportResult>;
    reset(options?: SqliteStateBatchOptions): Promise<SqliteStateBatchResult>;
    runtimeInfo(): Promise<SqliteStateRuntimeInfo>;
    dispose(): Promise<void>;
}
export declare function applicationId(): number;
export declare function internalSchemaVersion(): number;
//# sourceMappingURL=database.d.ts.map