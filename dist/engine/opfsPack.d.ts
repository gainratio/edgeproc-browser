export declare const PACK_DIR = "pack";
export interface PackedChunk {
    readonly hash: string;
    readonly compressed: Uint8Array;
}
export declare class OpfsPacks {
    #private;
    constructor(dir: FileSystemDirectoryHandle, maxChunkBytes: number);
    has(hash: string): Promise<boolean>;
    /** The stored bytes of `hash`, or null when no pack holds it. */
    read(hash: string): Promise<Uint8Array | null>;
    /** Land a batch: data file, then index. On failure neither remains. */
    write(chunks: ReadonlyArray<PackedChunk>): Promise<void>;
    /** Forget one chunk durably (its index is rewritten without it). */
    evict(hash: string): Promise<void>;
    /** Keep only `live` chunks. Dead packs go; mostly-dead ones are compacted. */
    retain(live: ReadonlySet<string>): Promise<void>;
    clear(): Promise<void>;
}
//# sourceMappingURL=opfsPack.d.ts.map