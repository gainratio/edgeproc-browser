import { type MemoryProfileSetting } from "../../sqlite/memoryProfile.js";
import type { Metadata, VectorHit, VectorIndex, VectorIndexCapabilities, VectorIndexOptions, VectorRecord, VectorStats } from "../types.js";
export type SqliteValue = string | number | null | Uint8Array;
/** Index options plus the SQLite memory profile ("auto" sizes it to the device). */
export interface SqliteVectorIndexOptions extends VectorIndexOptions {
    readonly memoryProfile?: MemoryProfileSetting;
}
/** Minimal synchronous SQLite surface used by the adapter and its test seam. */
export interface SqliteDatabase {
    exec(sql: string, bind?: ReadonlyArray<SqliteValue>): void;
    selectObjects(sql: string, bind?: ReadonlyArray<SqliteValue>): ReadonlyArray<Readonly<Record<string, unknown>>>;
    transaction<T>(callback: () => T): T;
    close(): void;
}
/** Raw SQLite OO1 shape shared by browser Worker and Node-only adapters. */
export interface RawSqliteDatabase {
    exec(options: {
        readonly sql: string;
        readonly bind?: unknown[];
    }): unknown;
    selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
    transaction<T>(callback: () => T): T;
    close(): void;
}
export interface SqliteVectorRuntimeInfo {
    readonly sqliteVersion: string;
    readonly vectorVersion: string;
    readonly vectorBackend: string;
    readonly bundledExtensions: ReadonlyArray<string>;
}
/** A caller-defined exact lookup term stored beside a vector record. */
export interface SqliteLookupKey {
    readonly namespace: string;
    readonly value: string;
}
/** A vector record with exact lookup terms for bounded candidate retrieval. */
export interface SqliteKeyedVectorRecord extends VectorRecord {
    readonly lookupKeys: ReadonlyArray<SqliteLookupKey>;
}
/** Adapt SQLite's OO1 database surface without leaking it into the index API. */
export declare function wrapSqliteDatabase(raw: RawSqliteDatabase): SqliteDatabase;
/** Exact FLOAT32 cosine index backed by SQLite plus sqlite-vector. */
export declare class SqliteDatabaseVectorIndex implements VectorIndex {
    #private;
    readonly name: string;
    readonly dimension: number;
    readonly capabilities: VectorIndexCapabilities;
    constructor(options: SqliteVectorIndexOptions, database: SqliteDatabase, persistent?: boolean);
    insert(records: ReadonlyArray<VectorRecord>): Promise<void>;
    insertKeyed(records: ReadonlyArray<SqliteKeyedVectorRecord>): Promise<void>;
    lookupIds(keys: ReadonlyArray<SqliteLookupKey>, maxDocumentFrequency: number): Promise<ReadonlyArray<string>>;
    read(id: string): Promise<VectorRecord | undefined>;
    search(query: Float32Array, limit: number, filters?: Metadata): Promise<ReadonlyArray<VectorHit>>;
    searchByIds(query: Float32Array, ids: ReadonlyArray<string>): Promise<ReadonlyArray<VectorHit>>;
    delete(ids: ReadonlyArray<string>, filters?: Metadata): Promise<number>;
    deleteWhere(filters: Metadata): Promise<number>;
    clear(): Promise<number>;
    stats(filters?: Metadata): Promise<VectorStats>;
    runtimeInfo(): SqliteVectorRuntimeInfo;
    dispose(): Promise<void>;
}
//# sourceMappingURL=database.d.ts.map