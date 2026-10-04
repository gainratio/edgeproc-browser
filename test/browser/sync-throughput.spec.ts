// Cold-sync throughput across engines, against the committed signed fixture
// (783 distinct ~2.5 KB chunks, the shape of edge-reco's real catalog bundle)
// served over plain HTTP by the Vite server (/__bundle/), with no request interception.
//
//   1. budget: a cold sync of the whole bundle finishes under
//      COLD_SYNC_BUDGET_MS in every engine, and when OPFS is the store, the
//      time spent writing chunks stays under OPFS_WRITE_BUDGET_MS_PER_CHUNK.
//   2. tamper: a chunk served as another chunk's valid zstd frame is still
//      refused and nothing is promoted.
//
// Set EDGEPROC_THROUGHPUT_LOG=1 to print the per-phase breakdown.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";

const BUNDLE = "/__bundle/catalog";
const KEY = "/__bundle/keys/public.key";
const FIXTURE = join(
	dirname(import.meta.dirname),
	"..",
	"src",
	"engine",
	"__fixtures__",
	"bundle",
);

/** Cold sync wall-clock ceiling for the 783-chunk fixture, any engine. Firefox
 * took 10.1 s here in a Linux container with one OPFS file per chunk. */
const COLD_SYNC_BUDGET_MS = 5_000;
/** Time inside the store's chunk writes, per chunk, when OPFS is the store.
 * One file per chunk cost 2.3-17 ms (Chromium/Firefox, macOS/Linux); batched
 * packs cost 0.2-0.6 ms. Independent of network speed, so it holds on slow CI. */
const OPFS_WRITE_BUDGET_MS_PER_CHUNK = 1.5;

function chunkHashes(): ReadonlyArray<string> {
	const dir = join(FIXTURE, "catalog");
	const pointer = JSON.parse(readFileSync(join(dir, "latest"), "utf8"));
	const manifest = JSON.parse(
		readFileSync(join(dir, "manifest", pointer.manifest_hash), "utf8"),
	);
	return [
		...new Set<string>(
			manifest.files.flatMap((file: { chunks: { hash: string }[] }) =>
				file.chunks.map((chunk) => chunk.hash),
			),
		),
	];
}

test.describe("cold sync throughput", () => {
	test.setTimeout(180_000);

	test.beforeEach(async ({ page }) => {
		await page.goto("/test/browser/sync-throughput-fixture.html");
		await expect(page.locator("#ready")).toHaveText("ready");
	});

	for (const backend of ["auto", "indexeddb"] as const) {
		test(`cold-syncs the full bundle (${backend}) under the budget`, async ({
			page,
			browserName,
		}) => {
			const timings = await page.evaluate(
				([base, key, chosen]) => window.throughput.cold(base, key, chosen),
				[BUNDLE, KEY, backend] as const,
			);
			if (process.env.EDGEPROC_THROUGHPUT_LOG) {
				const rounded = JSON.stringify(timings, (_, value) =>
					typeof value === "number" ? Math.round(value) : value,
				);
				console.log(`[throughput] ${browserName} ${rounded}`);
			}
			expect(timings.chunksFetched).toBe(chunkHashes().length);
			expect(timings.wallMs).toBeLessThan(COLD_SYNC_BUDGET_MS);
			if (timings.backend === "opfs+indexeddb") {
				expect(timings.putMs / timings.chunksFetched).toBeLessThan(
					OPFS_WRITE_BUDGET_MS_PER_CHUNK,
				);
			}
		});
	}

	test("times the SQLite insert phase for one row per chunk", async ({
		page,
		browserName,
	}) => {
		const timings = await page.evaluate(
			(rows) => window.throughput.sqlInsert(rows, 2_600),
			chunkHashes().length,
		);
		if (process.env.EDGEPROC_THROUGHPUT_LOG) {
			console.log(`[sql-insert] ${browserName} ${JSON.stringify(timings)}`);
		}
		expect(timings.rows).toBe(chunkHashes().length);
	});

	test("refuses a substituted chunk and promotes nothing", async ({ page }) => {
		const [victim, substitute] = chunkHashes();
		if (victim === undefined || substitute === undefined) {
			throw new Error("fixture needs two chunks");
		}
		const result = await page.evaluate(
			([base, key, tampered, other]) =>
				window.throughput.tamper(base, key, tampered, other),
			[BUNDLE, KEY, victim, substitute] as const,
		);
		expect(result).toEqual({ outcome: "IntegrityError", promoted: false });
	});
});
