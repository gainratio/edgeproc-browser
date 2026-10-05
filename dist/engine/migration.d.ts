import type { SqliteCacheStore } from "./sqliteStore.js";
import type { VersionPointer } from "./types.js";
export interface LegacySnapshot {
    readonly chunks: ReadonlyArray<{
        readonly hash: string;
        readonly body: Uint8Array;
    }>;
    readonly manifests: ReadonlyArray<{
        readonly hash: string;
        readonly body: Uint8Array;
    }>;
    /** Structurally valid durable pointers; signatures are not re-checked
     * because a floor only refuses, it never grants trust. */
    readonly pointers: ReadonlyArray<VersionPointer | null>;
}
/** A 0.2.x store: its floor alone, the whole store, then delete it. */
export interface LegacySource {
    readonly label: string;
    /** Only the durable pointers (the rollback floor). Small and read first. */
    readPointers(): Promise<ReadonlyArray<VersionPointer | null>>;
    read(): Promise<LegacySnapshot>;
    remove(): Promise<void>;
}
/** A 0.2.x rollback floor exists but could not be read. Nothing may be
 * promoted until it is (or the user explicitly resets the cache): accepting
 * a release without it could accept a rollback the old floor would refuse. */
export declare class LegacyFloorUnavailableError extends Error {
    constructor(cause: unknown);
}
/** Raise the store's floor with every legacy source's pointers (never lower
 * it). Throws LegacyFloorUnavailableError, changing nothing, if any source's
 * floor cannot be read. Read-only on the legacy side. */
export declare function importLegacyFloor(store: SqliteCacheStore, sources: ReadonlyArray<LegacySource>): Promise<void>;
export interface MigrationReport {
    readonly state: "already-done" | "migrated";
    readonly copiedChunks: number;
    readonly skippedChunks: number;
    readonly floor: number;
}
export declare function migrateLegacyStores(store: SqliteCacheStore, sources: ReadonlyArray<LegacySource>): Promise<MigrationReport>;
//# sourceMappingURL=migration.d.ts.map