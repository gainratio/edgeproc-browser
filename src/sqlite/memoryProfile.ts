// Memory profile: one typed place that sizes SQLite's own memory knobs to the device.
//
// WHY: a vector index must live in persistent SQLite (OPFS), not in-memory SQLite, and
// SQLite's page cache + heap limits keep the wasm heap bounded on weak devices (iPhone
// Safari dies with "[wasm] RangeError: Out of memory"). These are plain PRAGMAs; we only
// choose the numbers and prove SQLite accepted them.

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

const MIB = 1024 * 1024;

export const MEMORY_PROFILES: Readonly<Record<MemoryTier, MemoryProfile>> =
	Object.freeze({
		full: Object.freeze({
			tier: "full",
			cacheSizeKiB: 65536,
			softHeapLimitBytes: 128 * MIB,
			hardHeapLimitBytes: 192 * MIB,
			tempStore: "memory",
			mmapSizeBytes: 0,
		}),
		lite: Object.freeze({
			tier: "lite",
			cacheSizeKiB: 16384,
			softHeapLimitBytes: 48 * MIB,
			hardHeapLimitBytes: 96 * MIB,
			tempStore: "memory",
			mmapSizeBytes: 0,
		}),
		minimal: Object.freeze({
			tier: "minimal",
			cacheSizeKiB: 4096,
			softHeapLimitBytes: 16 * MIB,
			hardHeapLimitBytes: 48 * MIB,
			tempStore: "file",
			mmapSizeBytes: 0,
		}),
	});

/** The browser signals we look at. Every field is optional because Safari/Firefox omit some. */
export interface MemoryEnvironment {
	/** Chromium-only, capped at 8. Absent on Safari and Firefox, so never required. */
	readonly deviceMemory?: number | undefined;
	readonly hardwareConcurrency?: number | undefined;
	readonly userAgent?: string | undefined;
	readonly platform?: string | undefined;
	readonly maxTouchPoints?: number | undefined;
}

const RANK: Readonly<Record<MemoryTier, number>> = {
	minimal: 0,
	lite: 1,
	full: 2,
};

function weakest(a: MemoryTier, b: MemoryTier): MemoryTier {
	return RANK[a] <= RANK[b] ? a : b;
}

function isIos(env: MemoryEnvironment): boolean {
	if (/iPhone|iPad|iPod/.test(env.userAgent ?? "")) return true;
	// iPadOS reports itself as a Mac; only touch support tells them apart.
	return env.platform === "MacIntel" && (env.maxTouchPoints ?? 0) > 1;
}

function tierFromDeviceMemory(gib: number | undefined): MemoryTier {
	if (typeof gib !== "number" || !Number.isFinite(gib)) return "lite";
	if (gib >= 8) return "full";
	return gib > 2 ? "lite" : "minimal";
}

function tierFromCores(cores: number | undefined): MemoryTier {
	if (typeof cores !== "number" || !Number.isFinite(cores)) return "full";
	return cores <= 2 ? "lite" : "full";
}

/**
 * Pick a tier from the signals we can trust. Unknown memory is "lite", never "full":
 * only an explicit deviceMemory >= 8 earns "full". iOS is always "minimal".
 */
export function detectMemoryTier(env: MemoryEnvironment): MemoryTier {
	if (isIos(env)) return "minimal";
	return weakest(
		tierFromDeviceMemory(env.deviceMemory),
		tierFromCores(env.hardwareConcurrency),
	);
}

/** Read the live environment. Works in a window or a Worker; absent fields stay undefined. */
export function currentMemoryEnvironment(): MemoryEnvironment {
	const nav = (globalThis as unknown as { navigator?: Record<string, unknown> })
		.navigator;
	if (nav === undefined) return {};
	return {
		deviceMemory: nav.deviceMemory as number | undefined,
		hardwareConcurrency: nav.hardwareConcurrency as number | undefined,
		userAgent: nav.userAgent as string | undefined,
		platform: nav.platform as string | undefined,
		maxTouchPoints: nav.maxTouchPoints as number | undefined,
	};
}

/** Turn a caller setting (default "auto") into a concrete profile. */
export function resolveMemoryProfile(
	setting: MemoryProfileSetting = "auto",
	env: MemoryEnvironment = currentMemoryEnvironment(),
): MemoryProfile {
	if (setting === "auto") return MEMORY_PROFILES[detectMemoryTier(env)];
	const profile = Object.hasOwn(MEMORY_PROFILES, setting)
		? MEMORY_PROFILES[setting]
		: undefined;
	if (profile === undefined) {
		throw new TypeError(`unsupported memory profile: ${String(setting)}`);
	}
	return profile;
}

/** The slice of a SQLite handle this module needs. Structural, so any adapter fits. */
export interface MemoryProfileDatabase {
	exec(sql: string): void;
	selectObjects(sql: string): ReadonlyArray<Readonly<Record<string, unknown>>>;
}

const TEMP_STORE_CODE: Readonly<Record<TempStore, number>> = {
	file: 1,
	memory: 2,
};

function pragma(db: MemoryProfileDatabase, name: string): unknown {
	return db.selectObjects(`PRAGMA ${name}`)[0]?.[name];
}

/** Read the profile SQLite is actually running with. */
export function readMemoryProfile(db: MemoryProfileDatabase): MemoryProfile {
	const cache = Number(pragma(db, "cache_size"));
	const store = pragma(db, "temp_store") === 1 ? "file" : "memory";
	const tier =
		Object.values(MEMORY_PROFILES).find(
			(candidate) => candidate.cacheSizeKiB === -cache,
		)?.tier ?? "lite";
	return {
		tier,
		cacheSizeKiB: -cache,
		softHeapLimitBytes: Number(pragma(db, "soft_heap_limit")),
		hardHeapLimitBytes: Number(pragma(db, "hard_heap_limit")),
		tempStore: store,
		mmapSizeBytes: Number(pragma(db, "mmap_size")),
	};
}

/** Apply a profile and prove SQLite accepted it. Throws if any PRAGMA was ignored. */
export function applyMemoryProfile(
	db: MemoryProfileDatabase,
	profile: MemoryProfile,
): MemoryProfile {
	db.exec(`PRAGMA cache_size = -${profile.cacheSizeKiB}`);
	db.exec(`PRAGMA hard_heap_limit = ${profile.hardHeapLimitBytes}`);
	db.exec(`PRAGMA soft_heap_limit = ${profile.softHeapLimitBytes}`);
	db.exec(`PRAGMA temp_store = ${TEMP_STORE_CODE[profile.tempStore]}`);
	db.exec(`PRAGMA mmap_size = ${profile.mmapSizeBytes}`);
	const applied = readMemoryProfile(db);
	if (JSON.stringify(applied) !== JSON.stringify(profile)) {
		throw new Error(
			`SQLite did not apply the ${profile.tier} memory profile: ${JSON.stringify(applied)}`,
		);
	}
	return applied;
}
