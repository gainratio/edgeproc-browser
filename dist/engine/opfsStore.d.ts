import type { CacheStore, VersionPointer } from "./types.js";
/** Select the newest structurally valid durable pointer after a torn write. */
export declare function selectHighestPointer(candidates: ReadonlyArray<VersionPointer | null>): VersionPointer | null;
/** A promotion may only advance the durable identity, never fork it. */
export declare function canPromotePointer(current: VersionPointer | null, incoming: VersionPointer): boolean;
export declare class OpfsCacheStore implements CacheStore {
    #private;
    private constructor();
    /** Open (or create) the OPFS store root + chunk/manifest subdirs. */
    static open(): Promise<OpfsCacheStore>;
    hasChunk(chunkHash: string): Promise<boolean>;
    putChunkCompressed(chunkHash: string, compressed: Uint8Array, expectedSize: number): Promise<void>;
    getChunk(chunkHash: string, expectedSize: number): Promise<Uint8Array>;
    /** Best-effort delete of a corrupt cache object; a concurrent eviction is fine. */
    private evict;
    putManifest(manifestBytes: Uint8Array): Promise<string>;
    getManifest(manifestHash: string): Promise<Uint8Array>;
    readActive(): Promise<VersionPointer | null>;
    promote(pointer: VersionPointer): Promise<void>;
    clearActiveIf(expected: VersionPointer): Promise<boolean>;
    pruneInactive(): Promise<void>;
    clear(): Promise<void>;
    private readPointer;
    private readDurablePointers;
    private withMutationLock;
    private writeFile;
    private removeExcept;
    /** Read-only snapshot read (`getFile`). Unlike a sync access handle it takes
     * no exclusive lock, and Chromium does not serialise it, so warm-boot chunk
     * reads overlap. Trust is unchanged: callers verify every byte returned. */
    private readSnapshot;
    private readFile;
}
//# sourceMappingURL=opfsStore.d.ts.map