// The SQLite chunk store against real storage and the BUILT engine Worker, in
// Chromium, Firefox and WebKit. Each browser states its own storage outcome:
// Playwright's WebKit refuses the OPFS root, so there the proof is the honest
// in-memory status and the absence of any IndexedDB write.

import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";

const BUNDLE = join(
	dirname(import.meta.dirname),
	"..",
	"src",
	"engine",
	"__fixtures__",
	"bundle",
);
const CATALOG = join(BUNDLE, "catalog");
const PUBLIC_KEY = join(BUNDLE, "keys", "public.key");

/**
 * Per-chunk budgets (ms per chunk of the 783-chunk bundle), not wall-clock.
 * Cold = fetch through Playwright's route handler + verify + insert, so it is
 * dominated by the route and is noisy; warm = a fresh Worker's sync (every
 * chunk re-read and re-verified) + reading every file (every chunk re-read and
 * re-verified again). WebKit has no OPFS here, so its "warm" boot is a full
 * re-download into memory. Observed on an M-series Mac (2026-10-04), several
 * runs, under load: Chromium cold 2.2-5.2 / warm 1.6-1.8, Firefox cold
 * 2.9-5.0 / warm 2.3, WebKit cold 3.2 / warm 4.0. Budgets sit at about 2.5-3x
 * the worst run, so a regression that triples per-chunk cost fails.
 */
const BUDGET_MS_PER_CHUNK = {
	chromium: { cold: 12, warm: 5 },
	firefox: { cold: 12, warm: 7 },
	webkit: { cold: 12, warm: 12 },
} as const;

const POINTER = JSON.parse(readFileSync(join(CATALOG, "latest"), "utf8"));

interface ManifestFile {
	readonly path: string;
	readonly chunks: ReadonlyArray<{ readonly hash: string }>;
}

const FILES: ReadonlyArray<ManifestFile> = JSON.parse(
	readFileSync(join(CATALOG, "manifest", POINTER.manifest_hash), "utf8"),
).files;
const PATHS = FILES.map((file) => file.path);
const DISTINCT = [
	...new Set(FILES.flatMap((file) => file.chunks.map((c) => c.hash))),
];

async function open(page: Page): Promise<string[]> {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.context().route("**/bundle-origin/**", async (route) => {
		const relative = normalize(
			new URL(route.request().url()).pathname.replace("/bundle-origin/", ""),
		);
		const file =
			relative === "public.key" ? PUBLIC_KEY : join(CATALOG, relative);
		await route.fulfill({
			status: 200,
			headers: { "Cross-Origin-Resource-Policy": "same-origin" },
			body: readFileSync(file),
		});
	});
	await page.goto("/test/browser/sqlite-store-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	return errors;
}

function boot(page: Page, namespace: string) {
	return page.evaluate(
		(args) => window.sqliteStore.boot(args.namespace, args.paths),
		{ namespace, paths: PATHS },
	);
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

test("cold sync and warm boot stay inside the per-chunk budget, on the right storage", async ({
	page,
	browserName,
}) => {
	test.setTimeout(120_000);
	const errors = await open(page);
	const namespace = `budget-${crypto.randomUUID()}`;
	const cold = await boot(page, namespace);
	const warm = await boot(page, namespace);
	const audit = await page.evaluate(() => window.sqliteStore.audit());
	const perChunk = {
		cold: cold.syncMs / DISTINCT.length,
		warm: (warm.syncMs + warm.readMs) / DISTINCT.length,
	};
	console.log(
		JSON.stringify({
			browserName,
			chunks: DISTINCT.length,
			cold,
			warm,
			perChunk,
		}),
	);

	expect(cold).toMatchObject({ outcome: "ok", chunksFetched: DISTINCT.length });
	expect(warm.outcome).toBe("ok");
	expect(warm.digest).toBe(cold.digest);
	if (browserName === "webkit") {
		// OPFS refused: SQLite in memory, said plainly, re-downloaded per Worker.
		expect(cold.cacheBackend).toBe("sqlite-memory");
		expect(cold.cacheStorage).toMatchObject({
			persistence: "memory",
			reason: "opfs-unavailable",
		});
		expect(warm.chunksFetched).toBe(DISTINCT.length);
		expect(audit.opfsRoot).toMatch(/^refused/);
	} else {
		expect(cold.cacheBackend).toBe("sqlite-opfs");
		expect(cold.cacheStorage).toMatchObject({ persistence: "opfs" });
		expect(warm).toMatchObject({
			chunksFetched: 0,
			chunksReused: DISTINCT.length,
		});
	}
	// SQLite is the only store: nothing was ever written to IndexedDB.
	expect(audit.idbDatabases).toEqual([]);
	const budget =
		BUDGET_MS_PER_CHUNK[browserName as keyof typeof BUDGET_MS_PER_CHUNK];
	expect(perChunk.cold).toBeLessThan(budget.cold);
	expect(perChunk.warm).toBeLessThan(budget.warm);
	expect(errors).toEqual([]);
});

test("two tabs syncing and reading at once do not corrupt each other", async ({
	browser,
	browserName,
}) => {
	test.skip(
		browserName === "webkit",
		"no OPFS in Playwright WebKit: each tab is in memory",
	);
	test.setTimeout(120_000);
	const context = await browser.newContext();
	const [tabA, tabB] = [await context.newPage(), await context.newPage()];
	const errors = [...(await open(tabA)), ...(await open(tabB))];
	const namespace = `tabs-${crypto.randomUUID()}`;
	const [a, b] = await Promise.all([
		boot(tabA, namespace),
		boot(tabB, namespace),
	]);
	expect(a.outcome).toBe("ok");
	expect(b.outcome).toBe("ok");
	// Both persistent (the pool is held per operation, not per tab) ...
	expect(a.cacheStorage).toMatchObject({ persistence: "opfs" });
	expect(b.cacheStorage).toMatchObject({ persistence: "opfs" });
	// ... and the second sync reused what the first one stored.
	expect(a.chunksFetched + b.chunksFetched).toBe(DISTINCT.length);
	expect(a.digest).toBe(b.digest);
	// A third boot in either tab sees one complete, uncorrupted cache.
	const again = await boot(tabB, namespace);
	expect(again).toMatchObject({
		outcome: "ok",
		chunksFetched: 0,
		digest: a.digest,
	});
	expect(errors).toEqual([]);
	await context.close();
});

test("a chunk BLOB tampered at rest is refused, never served, and re-fetched", async ({
	page,
	browserName,
}) => {
	test.skip(
		browserName === "webkit",
		"no OPFS in Playwright WebKit: nothing persists to tamper",
	);
	test.setTimeout(120_000);
	const errors = await open(page);
	const namespace = `tamper-${crypto.randomUUID()}`;
	const first = await boot(page, namespace);
	expect(first.outcome).toBe("ok");
	const target = DISTINCT[0] as string;
	const plain = Buffer.from(
		zstdDecompressSync(readFileSync(join(CATALOG, "chunk", target))),
	);
	plain[0] = (plain[0] ?? 0) ^ 0xff;
	const changed = await page.evaluate(
		(args) => window.sqliteStore.tamperRow(args.namespace, args.hash, args.hex),
		{ namespace, hash: target, hex: hex(zstdCompressSync(plain)) },
	);
	expect(changed).toBe(1);
	// The forged row is refused (the sync re-reads and re-verifies every
	// chunk before it reports success) and evicted; the next sync fetches
	// exactly that one chunk again and serves the genuine bytes.
	const refused = await boot(page, namespace);
	expect(refused.outcome).toBe("integrity");
	const healed = await boot(page, namespace);
	expect(healed).toMatchObject({
		outcome: "ok",
		chunksFetched: 1,
		digest: first.digest,
	});
	expect(errors).toEqual([]);
});

test("0.2.x stores migrate once into SQLite and are deleted", async ({
	page,
	browserName,
}) => {
	test.skip(
		browserName === "webkit",
		"no OPFS in Playwright WebKit: no 0.2.x OPFS store can exist",
	);
	test.setTimeout(120_000);
	const errors = await open(page);
	const migrated = DISTINCT.slice(0, 40);
	await page.evaluate((seed) => window.sqliteStore.seedLegacy(seed), {
		chunks: migrated.map((hash) => ({
			hash,
			hex: hex(readFileSync(join(CATALOG, "chunk", hash))),
		})),
		manifest: {
			hash: POINTER.manifest_hash,
			hex: hex(readFileSync(join(CATALOG, "manifest", POINTER.manifest_hash))),
		},
		opfsPointer: POINTER,
		idbPointer: POINTER,
	});
	const before = await page.evaluate(() => window.sqliteStore.audit());
	expect(before.opfsRoot).toEqual(
		expect.arrayContaining(["active.a", "chunk", "manifest"]),
	);
	expect(before.idbKeys).toEqual(["active"]);

	const result = await boot(page, "edgeproc-browser");
	expect(result).toMatchObject({
		outcome: "ok",
		cacheBackend: "sqlite-opfs",
		chunksFetched: DISTINCT.length - migrated.length,
		chunksReused: migrated.length,
	});
	const after = await page.evaluate(() => window.sqliteStore.audit());
	expect(after.idbKeys).toEqual([]);
	expect(after.opfsRoot).not.toEqual(expect.arrayContaining(["chunk"]));
	expect(after.opfsRoot).not.toEqual(expect.arrayContaining(["manifest"]));
	expect(after.opfsRoot).not.toEqual(expect.arrayContaining(["active.a"]));
	expect(errors).toEqual([]);
});

test("a legacy rollback floor above the release survives migration and refuses it", async ({
	page,
	browserName,
}) => {
	test.setTimeout(120_000);
	const errors = await open(page);
	// The 0.2.x IndexedDB floor says sequence 5 was already promoted; the
	// bundle served now is sequence 1. The floor is never lowered: not by
	// migration (OPFS), and not by the in-memory fallback (WebKit, where
	// 0.2.x really did keep its whole cache in IndexedDB).
	await page.evaluate((seed) => window.sqliteStore.seedLegacy(seed), {
		chunks: [],
		manifest: null,
		opfsPointer: null,
		idbPointer: { ...POINTER, sequence: 5, version: "v5", signature: "x" },
	});
	const refused = await boot(page, "edgeproc-browser");
	expect(refused.outcome).toBe("rollback");
	const again = await boot(page, "edgeproc-browser");
	expect(again.outcome).toBe("rollback");
	const after = await page.evaluate(() => window.sqliteStore.audit());
	if (browserName === "webkit") {
		// Memory mode reads the old floor but never writes or deletes it.
		expect(after.idbKeys).toEqual(["active"]);
	} else {
		// Migrated into SQLite (where it now lives), then deleted.
		expect(after.idbKeys).toEqual([]);
	}
	expect(errors).toEqual([]);
});

test("a Worker killed mid-transaction leaves the pointer and floor fully old or fully new", async ({
	page,
	browserName,
}) => {
	test.skip(
		browserName === "webkit",
		"no OPFS in Playwright WebKit: nothing persists across a kill",
	);
	test.setTimeout(120_000);
	const errors = await open(page);
	const namespace = `kill-${crypto.randomUUID()}`;
	const first = await boot(page, namespace);
	expect(first.outcome).toBe("ok");
	const outcome = await page.evaluate(
		(args) => window.sqliteStore.killMidTransaction(args.namespace, args.ms),
		{ namespace, ms: 1_500 },
	);
	console.log(JSON.stringify({ browserName, ...outcome }));
	// The kill must land inside the transaction, or this proves nothing.
	expect(outcome.killedMidTransaction).toBe(true);
	expect(outcome.after.integrity).toBe("ok");
	const fullyOld = {
		floor: outcome.before.floor,
		identity: outcome.before.identity,
		pointer: outcome.before.pointer,
		chunks: outcome.before.chunks,
	};
	const fullyNew = {
		floor: 99,
		identity: "torn",
		pointer: null,
		chunks: outcome.before.chunks + outcome.rowsAttempted,
	};
	const { integrity: _ignored, ...after } = outcome.after;
	expect([fullyOld, fullyNew]).toContainEqual(after);
	// And the engine still boots on whatever survived, with no torn release.
	const again = await boot(page, namespace);
	if (after.floor === 99) expect(again.outcome).toBe("rollback");
	else
		expect(again).toMatchObject({
			outcome: "ok",
			chunksFetched: 0,
			digest: first.digest,
		});
	expect(errors).toEqual([]);
});
