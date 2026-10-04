// @vitest-environment node

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import {
	applyMemoryProfile,
	currentMemoryEnvironment,
	detectMemoryTier,
	MEMORY_PROFILES,
	type MemoryEnvironment,
	readMemoryProfile,
	resolveMemoryProfile,
} from "./memoryProfile";

const wasm = new Uint8Array(
	readFileSync(
		new URL("../vector/sqlite/assets/sqlite3.wasm", import.meta.url),
	),
);
const modulePromise = sqlite3InitModule({
	wasmBinary: wasm,
	print: () => undefined,
	printErr: () => undefined,
});

async function openRaw() {
	const sqlite = await modulePromise;
	const raw = new sqlite.oo1.DB(":memory:");
	return {
		exec: (sql: string) => void raw.exec({ sql }),
		selectObjects: (sql: string) => raw.selectObjects(sql),
	};
}

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MIB = 1024 * 1024;

describe("MEMORY_PROFILES (literal values the docs promise)", () => {
	it("pins every tier", () => {
		expect(MEMORY_PROFILES).toEqual({
			full: {
				tier: "full",
				cacheSizeKiB: 65536,
				softHeapLimitBytes: 128 * MIB,
				hardHeapLimitBytes: 192 * MIB,
				tempStore: "memory",
				mmapSizeBytes: 0,
			},
			lite: {
				tier: "lite",
				cacheSizeKiB: 16384,
				softHeapLimitBytes: 48 * MIB,
				hardHeapLimitBytes: 96 * MIB,
				tempStore: "memory",
				mmapSizeBytes: 0,
			},
			minimal: {
				tier: "minimal",
				cacheSizeKiB: 4096,
				softHeapLimitBytes: 16 * MIB,
				hardHeapLimitBytes: 48 * MIB,
				tempStore: "file",
				mmapSizeBytes: 0,
			},
		});
	});
});

describe("detectMemoryTier", () => {
	it("never trusts a missing deviceMemory: unknown desktop is lite", () => {
		expect(detectMemoryTier({})).toBe("lite");
		expect(detectMemoryTier({ hardwareConcurrency: 16 })).toBe("lite");
	});
	it("treats iPhone Safari as minimal even without deviceMemory", () => {
		expect(detectMemoryTier({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(
			"minimal",
		);
	});
	it("treats iPadOS masquerading as a Mac as minimal", () => {
		expect(
			detectMemoryTier({
				userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
				platform: "MacIntel",
				maxTouchPoints: 5,
			}),
		).toBe("minimal");
	});
	it("does not mistake a touchless Mac for an iPad", () => {
		expect(detectMemoryTier({ platform: "MacIntel", maxTouchPoints: 0 })).toBe(
			"lite",
		);
	});
	it("uses deviceMemory when Chromium reports it", () => {
		expect(detectMemoryTier({ deviceMemory: 8 })).toBe("full");
		expect(detectMemoryTier({ deviceMemory: 4 })).toBe("lite");
		expect(detectMemoryTier({ deviceMemory: 2 })).toBe("minimal");
		expect(detectMemoryTier({ deviceMemory: 0.5 })).toBe("minimal");
	});
	it("takes the weakest signal", () => {
		expect(detectMemoryTier({ deviceMemory: 8, userAgent: IPHONE })).toBe(
			"minimal",
		);
		expect(detectMemoryTier({ deviceMemory: 8, hardwareConcurrency: 2 })).toBe(
			"lite",
		);
	});
	it("only treats a multi-touch MacIntel as an iPad", () => {
		expect(detectMemoryTier({ platform: "MacIntel", maxTouchPoints: 1 })).toBe(
			"lite",
		);
		expect(detectMemoryTier({ platform: "Win32", maxTouchPoints: 10 })).toBe(
			"lite",
		);
	});
	it("keeps full when deviceMemory is high and cores are plentiful", () => {
		expect(detectMemoryTier({ deviceMemory: 8, hardwareConcurrency: 3 })).toBe(
			"full",
		);
	});
	it("ignores garbage values", () => {
		const bad = { deviceMemory: Number.NaN } as MemoryEnvironment;
		expect(detectMemoryTier(bad)).toBe("lite");
	});
});

describe("resolveMemoryProfile", () => {
	it("returns an explicit tier unchanged", () => {
		expect(resolveMemoryProfile("minimal")).toBe(MEMORY_PROFILES.minimal);
	});
	it("auto uses the supplied environment", () => {
		expect(resolveMemoryProfile("auto", { deviceMemory: 8 }).tier).toBe("full");
		expect(resolveMemoryProfile(undefined, { userAgent: IPHONE }).tier).toBe(
			"minimal",
		);
	});
	it("rejects an unknown tier", () => {
		expect(() => resolveMemoryProfile("huge" as never)).toThrow(TypeError);
		expect(() => resolveMemoryProfile("huge" as never)).toThrow(
			"unsupported memory profile: huge",
		);
	});
});

describe("currentMemoryEnvironment", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});
	it("copies the navigator signals", () => {
		vi.stubGlobal("navigator", {
			deviceMemory: 4,
			hardwareConcurrency: 6,
			userAgent: IPHONE,
			platform: "iPhone",
			maxTouchPoints: 5,
		});
		expect(currentMemoryEnvironment()).toEqual({
			deviceMemory: 4,
			hardwareConcurrency: 6,
			userAgent: IPHONE,
			platform: "iPhone",
			maxTouchPoints: 5,
		});
		expect(resolveMemoryProfile().tier).toBe("minimal");
	});
	it("returns no signals when there is no navigator", () => {
		vi.stubGlobal("navigator", undefined);
		expect(currentMemoryEnvironment()).toEqual({});
	});
});

describe("readMemoryProfile", () => {
	it("falls back to lite when the cache size matches no profile", async () => {
		const db = await openRaw();
		db.exec("PRAGMA cache_size = -1234");
		expect(readMemoryProfile(db)).toMatchObject({
			tier: "lite",
			cacheSizeKiB: 1234,
		});
	});
});

describe("applyMemoryProfile reads the PRAGMAs back", () => {
	for (const tier of ["full", "lite", "minimal"] as const) {
		it(`applies ${tier}`, async () => {
			const db = await openRaw();
			const profile = MEMORY_PROFILES[tier];
			expect(applyMemoryProfile(db, profile)).toEqual(readMemoryProfile(db));
			expect(readMemoryProfile(db)).toEqual(profile);
			expect(db.selectObjects("PRAGMA cache_size")[0]?.cache_size).toBe(
				-profile.cacheSizeKiB,
			);
			expect(
				db.selectObjects("PRAGMA hard_heap_limit")[0]?.hard_heap_limit,
			).toBe(profile.hardHeapLimitBytes);
		});
	}
	it("fails closed when SQLite does not honour a pragma", async () => {
		const db = await openRaw();
		const ignoring = {
			exec: () => undefined,
			selectObjects: db.selectObjects,
		};
		expect(() => applyMemoryProfile(ignoring, MEMORY_PROFILES.minimal)).toThrow(
			/memory profile/,
		);
	});
	it("fails closed with its own error when a PRAGMA returns no row", () => {
		const empty = { exec: () => undefined, selectObjects: () => [] };
		expect(() => applyMemoryProfile(empty, MEMORY_PROFILES.lite)).toThrow(
			"SQLite did not apply the lite memory profile",
		);
	});
});
