import { expect, type Page, test } from "@playwright/test";

// sqlite3.mjs installs its OPFS VFSes by spawning sqlite3-opfs-async-proxy.js
// as a nested Worker and giving that spawn 4 s (its "zombie timer"). When the
// proxy came over the network, a saturated link (slow 4G under an 8-way chunk
// sync) lost that race, the VFS was skipped with a console warning, and the
// durable state store could not open. These proofs pin the fix: the proxy
// ships inline, so the install needs no network at all.

async function proxyProbe(
	page: Page,
	hold?: number,
): Promise<{ holdMs: number; requests: number }> {
	const url =
		hold === undefined
			? "/__test/opfs-proxy"
			: `/__test/opfs-proxy?hold=${hold}`;
	const response = await page.request.get(url);
	return (await response.json()) as { holdMs: number; requests: number };
}

// Each VFS install spawns its own proxy Worker, so a prelude runs twice
// (once for "opfs", once for "opfs-wl") and the timings below are per VFS.
const SLOW_ROOT_MS = 6_000; // slower than sqlite3.mjs's 4 s zombie timer
const slowRoot = `const __root = navigator.storage.getDirectory.bind(navigator.storage);
navigator.storage.getDirectory = () => new Promise((resolve) => setTimeout(() => resolve(__root()), ${SLOW_ROOT_MS}));`;
const refusedRoot = `navigator.storage.getDirectory = () => Promise.reject(new DOMException("refused by the test", "UnknownError"));`;

test("keeps waiting for a slow OPFS root instead of giving up at the 4 s zombie timer", async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.goto("/test/browser/fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	const result = await page.evaluate(
		(prelude) => window.runOpfsInstallProbe({ prelude }),
		slowRoot,
	);
	expect(result.warnings).toEqual([]);
	expect(result.opfs).toBe(true);
	expect(result.opfsWl).toBe(true);
	expect(result.elapsedMs).toBeGreaterThanOrEqual(2 * SLOW_ROOT_MS);
});

test("reports a refused OPFS root at once, without waiting out the zombie timer", async ({
	page,
}) => {
	await page.goto("/test/browser/fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	const result = await page.evaluate(
		(prelude) => window.runOpfsInstallProbe({ prelude }),
		refusedRoot,
	);
	expect(result.opfs).toBe(false);
	expect(result.opfsWl).toBe(false);
	expect(result.warnings.join("\n")).toContain("refused by the test");
	expect(result.elapsedMs).toBeLessThan(3_000);
});

test("still gives up on a proxy script that loads but never answers (the guard the timer exists for)", async ({
	page,
}) => {
	await page.goto("/test/browser/fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	const result = await page.evaluate(() =>
		window.runOpfsInstallProbe({ prelude: "", body: "/* never posts */" }),
	);
	expect(result.opfs).toBe(false);
	expect(result.opfsWl).toBe(false);
	expect(result.warnings.join("\n")).toContain(
		"Timeout while waiting for OPFS async proxy worker",
	);
	expect(result.elapsedMs).toBeGreaterThanOrEqual(2 * 4_000);
});

test("opens the durable state store without fetching the OPFS async proxy, even when the network would hold it past the 4 s zombie timer", async ({
	page,
}) => {
	await page.goto("/test/browser/fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	// Longer than sqlite3.mjs's 4 s zombie timer: the old install lost here.
	await proxyProbe(page, 9_000);
	try {
		const result = await page.evaluate(
			(name) => window.runSqliteOpfsOpenProof(name),
			`held-proxy-${crypto.randomUUID()}`,
		);
		const probe = await proxyProbe(page);
		expect(result.error).toBeUndefined();
		expect(result.persistence).toBe("opfs");
		expect(probe.requests).toBe(0);
	} finally {
		await proxyProbe(page, 0);
	}
});
