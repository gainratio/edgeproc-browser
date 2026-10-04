import type { SqlBind, SqlExecResult, SqlRow } from "../sql/types.js";
import type { CacheStore, VersionPointer } from "./types.js";
/** The slice of the in-Worker SqlEngine this store needs. */
export interface ChunkSqlConnection {
    exec(sql: string, bind?: SqlBind): SqlExecResult;
    query(sql: string, bind?: SqlBind): SqlRow[];
    /** BEGIN IMMEDIATE … COMMIT around `work`; a throw rolls it back. */
    immediate<T>(work: () => T): T;
}
/** A verified chunk ready to insert: `size` is its plaintext length. */
export interface VerifiedChunk {
    readonly hash: string;
    readonly size: number;
    readonly body: Uint8Array;
}
export interface LegacyImport {
    readonly chunks: ReadonlyArray<VerifiedChunk>;
    readonly manifests: ReadonlyArray<{
        readonly hash: string;
        readonly body: Uint8Array;
    }>;
    readonly pointers: ReadonlyArray<VersionPointer | null>;
}
export type MigrationState = "none" | "copied" | "done";
export declare const CHUNK_SCHEMA_VERSION = 1;
export declare class SqliteCacheStore implements CacheStore {
    #private;
    private constructor();
    /** Create the schema if needed. Incremental auto-vacuum is set before the
     * first table exists, so pruned pages can be handed back to the browser. */
    static open(db: ChunkSqlConnection): SqliteCacheStore;
    hasChunk(chunkHash: string): Promise<boolean>;
    putChunkCompressed(chunkHash: string, compressed: Uint8Array, expectedSize: number): Promise<void>;
    /** Commit verified chunks still held in memory (one transaction). */
    flush(): Promise<void>;
    getChunk(chunkHash: string, expectedSize: number): Promise<Uint8Array>;
    putManifest(manifestBytes: Uint8Array): Promise<string>;
    getManifest(manifestHash: string): Promise<Uint8Array>;
    readActive(): Promise<VersionPointer | null>;
    /** The highest sequence ever promoted here; -1 when there is none. */
    readFloor(): Promise<number>;
    promote(pointer: VersionPointer, chunks?: ReadonlyArray<string>): Promise<void>;
    clearActiveIf(expected: VersionPointer): Promise<boolean>;
    /** Eviction is a DELETE of everything the active release does not use,
     * then an incremental vacuum so the freed pages leave the file. With
     * `secure_delete` on (the SQL seam sets it for OPFS), deleted bytes are
     * overwritten, not just unlinked. */
    pruneInactive(): Promise<void>;
    /** The explicit reset: chunks, manifests, the pointer AND the floor. */
    clear(): Promise<void>;
    migrationState(): MigrationState;
    /**
     * Copy a legacy store in ONE transaction: chunks and manifests (already
     * verified by the caller), and the legacy pointers as a floor that can
     * only raise this one. Idempotent: running it twice changes nothing.
     */
    importLegacy(input: LegacyImport): void;
    /** Raise (never lower) the floor with legacy pointers; one transaction,
     * migration state untouched. */
    raiseLegacyFloor(pointers: ReadonlyArray<VersionPointer | null>): void;
    markMigrationDone(): void;
}
/** The fields `samePointer` compares, in a fixed order: one string per release. */
export declare function pointerIdentity(pointer: VersionPointer): string;
//# sourceMappingURL=sqliteStore.d.ts.map