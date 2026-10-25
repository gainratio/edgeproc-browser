import type { CacheStore, VersionPointer } from "./types.js";
export declare class MemoryCacheStore implements CacheStore {
    #private;
    hasChunk(chunkHash: string): Promise<boolean>;
    putChunkCompressed(chunkHash: string, compressed: Uint8Array, expectedSize: number): Promise<void>;
    getChunk(chunkHash: string, expectedSize: number): Promise<Uint8Array>;
    putManifest(manifestBytes: Uint8Array): Promise<string>;
    getManifest(manifestHash: string): Promise<Uint8Array>;
    readActive(): Promise<VersionPointer | null>;
    promote(pointer: VersionPointer): Promise<void>;
    clearActiveIf(expected: VersionPointer): Promise<boolean>;
    readTrustRoot(): Promise<Uint8Array | null>;
    putTrustRoot(bytes: Uint8Array): Promise<void>;
    pruneInactive(): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=memoryStore.d.ts.map