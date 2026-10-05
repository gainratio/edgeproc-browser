// Warm-boot proofs against real OPFS and the BUILT Worker (tamper-at-rest
// lives in sqlite-store.spec.ts, against the SQLite chunk table):
//   1. network stall mid-sync: chunk requests are held for longer than the
//      client's default idle deadline; the sync must survive it, announce the
//      stall, and re-fetch only the chunks that were in flight.
//   2. benchmark (opt-in): cold and warm sync + read times for a real bundle.
//
// Bundle: the committed fixture by default. Set EDGEPROC_BENCH_BUNDLE to a
// directory holding `latest`, `manifest/`, `chunk/` and `public.key` (e.g. a
// read-only copy of almamesh's public/bundle) to run both against it.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";

const FIXTURE = join(
	dirname(import.meta.dirname),
	"..",
	"src",
	"engine",
	"__fixtures__",
	"bundle",
);
const BENCH = process.env.EDGEPROC_BENCH_BUNDLE;
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

/** Serves the bundle from disk; `gate` may hold a chunk request instead. */
async function openHarness(
	page: Page,
	gate: (route: Route, chunkHash: string) => boolean = () => false,
): Promise<void> {
	await page.context().route("**/bundle-origin/**", async (route) => {
		const relative = normalize(
			new URL(route.request().url()).pathname.replace("/bundle-origin/", ""),
		);
		const chunk = relative.match(/^chunk\/([0-9a-f]{64})$/u)?.[1];
		if (chunk !== undefined && gate(route, chunk)) return;
		await serve(route, relative);
	});
	await page.goto("/test/browser/warm-sync-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
}

async function serve(route: Route, relative: string): Promise<void> {
	const file = relative === "public.key" ? PUBLIC_KEY : join(BUNDLE, relative);
	await route.fulfill({
		status: 200,
		headers: { "Cross-Origin-Resource-Policy": "same-origin" },
		body: readFileSync(file),
	});
}

/**
 * A network stall: after `serveBefore` chunk requests have been answered,
 * every chunk request is held (no headers, no bytes) until `holdMs` after
 * the first one was held; then all held requests are released and later ones
 * are served normally. Counts how many times each chunk was requested.
 */
function stallGate(serveBefore: number, holdMs: number) {
	const requests = new Map<string, number>();
	const held: Array<{ route: Route; hash: string }> = [];
	const everHeld = new Set<string>();
	let served = 0;
	let holdStarted: number | null = null;
	const release = (): void => {
		for (const { route, hash } of held.splice(0)) {
			// The Worker aborts a stalled fetch itself; fulfilling a request it
			// already gave up on is not an error worth failing the test for.
			serve(route, `chunk/${hash}`).catch(() => undefined);
		}
	};
	return {
		requests,
		heldHashes: (): ReadonlyArray<string> => [...everHeld],
		gate: (route: Route, hash: string): boolean => {
			requests.set(hash, (requests.get(hash) ?? 0) + 1);
			if (served < serveBefore) {
				served += 1;
				return false;
			}
			if (holdStarted === null) {
				holdStarted = Date.now();
				setTimeout(release, holdMs);
			}
			if (Date.now() - holdStarted >= holdMs) return false;
			held.push({ route, hash });
			everHeld.add(hash);
			return true;
		},
	};
}

// The production outage this guards: on slow 4G the sync Worker's progress
// (reported per completed chunk) went quiet for longer than the client's 60 s
// idle deadline, the Worker was killed mid-sync, and the app never started.
// Here the network goes silent for 75 s in the middle of a cold sync: longer
// than the deadline, long enough for the stall watchdog to fire twice.
test("survives a 75 s network stall mid-sync and re-fetches only the stalled chunks", async ({
	page,
}) => {
	test.setTimeout(180_000);
	const HOLD_MS = 75_000;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const stall = stallGate(100, HOLD_MS);
	await openHarness(page, stall.gate);
	const totalChunks = new Set(
		manifestFiles().flatMap((file) => file.chunks.map((chunk) => chunk.hash)),
	).size;

	const outcome = await page.evaluate(
		(namespace) => window.warmSync.stallSync(namespace),
		`stall-${crypto.randomUUID()}`,
	);

	// Survived: not WorkerTimeoutError, every chunk fetched, bundle verified.
	expect(outcome.outcome).toBe("ok");
	expect(outcome.chunksFetched).toBe(totalChunks);
	expect(outcome.elapsedMs).toBeGreaterThanOrEqual(HOLD_MS);
	expect(outcome.bytesDone).toBe(outcome.bytesTotal);
	expect(outcome.verifyEvents).toBeGreaterThan(0);

	// The stall was named: each held chunk timed out twice (30 s + 30 s < 75 s)
	// with the specific stall error, and each was announced as a retry.
	const heldHashes = stall.heldHashes();
	expect(heldHashes.length).toBeGreaterThan(0);
	expect(outcome.retries.length).toBe(heldHashes.length * 2);
	for (const retry of outcome.retries) {
		expect(heldHashes).toContain(retry.hash);
		expect([1, 2]).toContain(retry.attempt);
		expect(retry.reason).toMatch(/stalled: no bytes for 30000ms/u);
	}
	// The client never went 60 s without hearing from the Worker.
	expect(outcome.longestGapMs).toBeLessThan(60_000);

	// Resumable: chunks verified before the stall were requested exactly once;
	// only the stalled ones were requested again (3 attempts each).
	let onceCount = 0;
	for (const [hash, count] of stall.requests) {
		if (heldHashes.includes(hash)) expect(count).toBe(3);
		else {
			expect(count).toBe(1);
			onceCount += 1;
		}
	}
	expect(onceCount).toBe(totalChunks - heldHashes.length);
	expect(errors).toEqual([]);
});

test("benchmark: cold vs warm sync on a real bundle", async ({ page }) => {
	test.skip(BENCH === undefined, "set EDGEPROC_BENCH_BUNDLE to benchmark");
	test.setTimeout(180_000);
	await openHarness(page);
	const paths = manifestFiles().map((file) => file.path);
	const namespace = `bench-${crypto.randomUUID()}`;
	const boot = () =>
		page.evaluate((args) => window.warmSync.boot(args.namespace, args.paths), {
			namespace,
			paths,
		});
	const cold = await boot();
	const warm = [await boot(), await boot(), await boot(), await boot()];
	expect(cold.chunksFetched).toBeGreaterThan(0);
	for (const run of warm) expect(run.chunksFetched).toBe(0);
	const report = {
		bundle: BENCH,
		files: paths.length,
		cold,
		warm,
	};
	console.log(JSON.stringify(report));
	const out = process.env.EDGEPROC_BENCH_OUT;
	if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 1));
});
