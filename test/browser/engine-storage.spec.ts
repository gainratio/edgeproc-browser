import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { expect, type Page, test } from "@playwright/test";

const CATALOG = join(
	dirname(import.meta.dirname),
	"..",
	"src",
	"engine",
	"__fixtures__",
	"bundle",
	"catalog",
);

/** Serve the committed signed bundle; count every request for it. */
async function serveBundle(page: Page): Promise<{ requests: number }> {
	const counter = { requests: 0 };
	await page.context().route("**/bundle-origin/**", async (route) => {
		counter.requests += 1;
		const relative = normalize(
			new URL(route.request().url()).pathname.replace("/bundle-origin/", ""),
		);
		await route.fulfill({
			status: 200,
			headers: { "Cross-Origin-Resource-Policy": "same-origin" },
			body: readFileSync(join(CATALOG, relative)),
		});
	});
	return counter;
}

test('OPFS refused + cacheFallback "none": typed EngineStorageUnavailableError, nothing downloaded', async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	const bundle = await serveBundle(page);
	await page.goto("/test/browser/engine-storage-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const refused = await page.evaluate(
		(namespace) => window.runEngineRefusal(namespace, "none"),
		`playwright-${crypto.randomUUID()}`,
	);
	expect(refused).toMatchObject({
		outcome: "EngineStorageUnavailableError",
		typed: true,
		code: "storage",
		reason: "opfs-unavailable",
	});
	expect(refused.elapsedMs).toBeLessThan(5_000);
	expect(bundle.requests).toBe(0);

	// Same refused OPFS, default option: the engine falls back to RAM and
	// downloads, so the refusal above is real and the option is the difference.
	const fallback = await page.evaluate(
		(namespace) => window.runEngineRefusal(namespace),
		`playwright-${crypto.randomUUID()}`,
	);
	expect(fallback.outcome).toBe("synced:sqlite-memory");
	expect(bundle.requests).toBeGreaterThan(0);
	expect(errors).toEqual([]);
});
