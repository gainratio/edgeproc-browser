export type MemoryTier = "full" | "lite" | "minimal";
export type MemoryProfileSetting = MemoryTier | "auto";
export type TempStore = "memory" | "file";
export interface MemoryProfile {
    readonly tier: MemoryTier;
    /** PRAGMA cache_size, as a positive KiB count (applied as a negative value). */
    readonly cacheSizeKiB: number;
    /** PRAGMA soft_heap_limit: SQLite frees cache to stay under this. */
    readonly softHeapLimitBytes: number;
    /** PRAGMA hard_heap_limit: allocations beyond this fail with SQLITE_NOMEM, not a crash. */
    readonly hardHeapLimitBytes: number;
    /** PRAGMA temp_store. */
    readonly tempStore: TempStore;
    /** PRAGMA mmap_size. The wasm build has no mmap, so this is pinned to 0. */
    readonly mmapSizeBytes: number;
}
export declare const MEMORY_PROFILES: Readonly<Record<MemoryTier, MemoryProfile>>;
/** The browser signals we look at. Every field is optional because Safari/Firefox omit some. */
export interface MemoryEnvironment {
    /** Chromium-only, capped at 8. Absent on Safari and Firefox, so never required. */
    readonly deviceMemory?: number | undefined;
    readonly hardwareConcurrency?: number | undefined;
    readonly userAgent?: string | undefined;
    readonly platform?: string | undefined;
    readonly maxTouchPoints?: number | undefined;
}
/**
 * Pick a tier from the signals we can trust. Unknown memory is "lite", never "full":
 * only an explicit deviceMemory >= 8 earns "full". iOS is always "minimal".
 */
export declare function detectMemoryTier(env: MemoryEnvironment): MemoryTier;
/** Read the live environment. Works in a window or a Worker; absent fields stay undefined. */
export declare function currentMemoryEnvironment(): MemoryEnvironment;
/** Turn a caller setting (default "auto") into a concrete profile. */
export declare function resolveMemoryProfile(setting?: MemoryProfileSetting, env?: MemoryEnvironment): MemoryProfile;
/** The slice of a SQLite handle this module needs. Structural, so any adapter fits. */
export interface MemoryProfileDatabase {
    exec(sql: string): void;
    selectObjects(sql: string): ReadonlyArray<Readonly<Record<string, unknown>>>;
}
/** Read the profile SQLite is actually running with. */
export declare function readMemoryProfile(db: MemoryProfileDatabase): MemoryProfile;
/** Apply a profile and prove SQLite accepted it. Throws if any PRAGMA was ignored. */
export declare function applyMemoryProfile(db: MemoryProfileDatabase, profile: MemoryProfile): MemoryProfile;
//# sourceMappingURL=memoryProfile.d.ts.map