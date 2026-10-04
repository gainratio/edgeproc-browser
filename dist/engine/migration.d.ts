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
/** A 0.2.x store: read it whole, then delete it. */
export interface LegacySource {
    readonly label: string;
    read(): Promise<LegacySnapshot>;
    remove(): Promise<void>;
}
export interface MigrationReport {
    readonly state: "already-done" | "migrated";
    readonly copiedChunks: number;
    readonly skippedChunks: number;
    readonly floor: number;
}
export declare function migrateLegacyStores(store: SqliteCacheStore, sources: ReadonlyArray<LegacySource>): Promise<MigrationReport>;
//# sourceMappingURL=migration.d.ts.map