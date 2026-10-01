// Warm-boot proofs against real OPFS and the BUILT Worker:
//   1. tamper-at-rest: same-origin code rewrites a cached chunk with a VALID
//      zstd frame of different bytes; the engine must refuse it (never hand it
//      to the app) and the next sync must re-fetch the genuine chunk.
//   2. benchmark (opt-in): cold and warm sync + read times for a real bundle.
//
// Bundle: the committed fixture by default. Set EDGEPROC_BENCH_BUNDLE to a
// directory holding `latest`, `manifest/`, `chunk/` and `public.key` (e.g. a
// read-only copy of almamesh's public/bundle) to run both against it.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";

const FIXTURE = join(
	dirname(import.meta.dirname),
	"..",
	"src",
	"engine",
	"__fixtures__",
	"bundle",
);
const BENCH = process.env.EDGEPROC_BENCH_BUNDLE;
const BACKEND: "auto" | "indexeddb" =
	process.env.EDGEPROC_BENCH_BACKEND === "indexeddb" ? "indexeddb" : "auto";
const BUNDLE = BENCH ?? join(FIXTURE, "catalog");
const PUBLIC_KEY = BENCH
	? join(BENCH, "public.key")
	: join(FIXTURE, "keys", "public.key");

interface ManifestFile {
	readonly path: string;
	readonly chunks: ReadonlyArray<{ readonly hash: string }>;
}

function manifestFiles(): ReadonlyArray<ManifestFile> {
	const pointer = JSON.parse(readFileSync(join(BUNDLE, "latest"), "utf8"));
	const raw = readFileSync(join(BUNDLE, "manifest", pointer.manifest_hash));
	return JSON.parse(raw.toString("utf8")).files;
}

async function openHarness(page: Page): Promise<void> {
	await page.context().route("**/bundle-origin/**", async (route) => {
		const relative = normalize(
			new URL(route.request().url()).pathname.replace("/bundle-origin/", ""),
		);
		const file =
			relative === "public.key" ? PUBLIC_KEY : join(BUNDLE, relative);
		await route.fulfill({
			status: 200,
			headers: { "Cross-Origin-Resource-Policy": "same-origin" },
			body: readFileSync(file),
		});
	});
	await page.goto("/test/browser/warm-sync-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
}

/** A valid single-frame zstd chunk of the right size but one flipped byte:
 * it decompresses cleanly, so only the content-address check can catch it. */
function forgeChunk(chunkHash: string): string {
	const plain = Buffer.from(
		zstdDecompressSync(readFileSync(join(BUNDLE, "chunk", chunkHash))),
	);
	plain[0] = (plain[0] ?? 0) ^ 0xff;
	return zstdCompressSync(plain).toString("hex");
}

test("a chunk tampered at rest is refused, never served, and re-fetched", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await openHarness(page);
	const target = manifestFiles().find((file) => file.chunks.length > 0);
	if (target === undefined) throw new Error("bundle has no chunked file");
	const chunkHash = target.chunks[0]?.hash as string;

	const outcome = await page.evaluate(
		(args) =>
			window.warmSync.tamper(
				args.namespace,
				args.path,
				args.chunkHash,
				args.forged,
			),
		{
			namespace: `tamper-${crypto.randomUUID()}`,
			path: target.path,
			chunkHash,
			forged: forgeChunk(chunkHash),
		},
	);

	expect(outcome.tamperedReadCode).toBe("integrity");
	expect(outcome.tamperedSyncCode).toBe("integrity");
	expect(outcome.healedChunksFetched).toBe(1);
	expect(outcome.healedBytesMatch).toBe(true);
	expect(errors).toEqual([]);
});

test("benchmark: cold vs warm sync on a real bundle", async ({ page }) => {
	test.skip(BENCH === undefined, "set EDGEPROC_BENCH_BUNDLE to benchmark");
	test.setTimeout(180_000);
	await openHarness(page);
	const paths = manifestFiles().map((file) => file.path);
	const namespace = `bench-${crypto.randomUUID()}`;
	const boot = () =>
		page.evaluate(
			(args) => window.warmSync.boot(args.namespace, args.paths, args.backend),
			{ namespace, paths, backend: BACKEND },
		);
	const cold = await boot();
	const warm = [await boot(), await boot(), await boot(), await boot()];
	expect(cold.chunksFetched).toBeGreaterThan(0);
	for (const run of warm) expect(run.chunksFetched).toBe(0);
	const report = {
		bundle: BENCH,
		backend: BACKEND,
		files: paths.length,
		cold,
		warm,
	};
	console.log(JSON.stringify(report));
	const out = process.env.EDGEPROC_BENCH_OUT;
	if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 1));
});
