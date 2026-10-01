import { expect, test } from "@playwright/test";

// The OPFS async proxy is spawned from a same-origin Blob URL; a blob URL's
// own hostname is empty, so judge it by the origin it was minted for.
function isExternal(url: URL): boolean {
	const origin = url.protocol === "blob:" ? new URL(url.pathname) : url;
	return origin.hostname !== "127.0.0.1";
}

test("persists exact vector search in OPFS across a Worker restart", async ({
	page,
}) => {
	const externalRequests: string[] = [];
	page.on("request", (request) => {
		if (isExternal(new URL(request.url()))) {
			externalRequests.push(request.url());
		}
	});
	await page.goto("/test/browser/fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const result = await page.evaluate(async (name) => {
		return window.runSqliteVectorProof(name);
	}, `playwright-${crypto.randomUUID()}`);

	expect(result).toEqual({
		runtime: {
			sqliteVersion: "3.53.4",
			vectorVersion: "1.1.2",
			vectorBackend: "CPU",
			bundledExtensions: ["vector_version"],
		},
		firstNearest: "closest",
		namedIds: ["closest", "far"],
		keyedIds: ["keyed"],
		deletedWhere: 1,
		reopenedNearest: "closest",
		reopenedCount: 2,
		cleared: 2,
	});
	expect(externalRequests).toEqual([]);
});

test("exports, validates, atomically imports, and reopens application state", async ({
	page,
}) => {
	const externalRequests: string[] = [];
	page.on("request", (request) => {
		if (isExternal(new URL(request.url())))
			externalRequests.push(request.url());
	});
	await page.goto("/test/browser/fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const result = await page.evaluate(async (name) => {
		return window.runSqliteStateProof(name);
	}, `state-${crypto.randomUUID()}`);

	expect(result.crossOriginIsolated).toBe(true);
	expect(result.runtime).toEqual({
		name: expect.stringMatching(/^state-/),
		sqliteVersion: "3.53.4",
		persistence: "opfs",
		ownership: "shared-opfs-web-locks",
		schemaVersion: 3,
		epoch: 1,
		rowCount: 2,
	});
	expect(result.sqliteHeader).toBe("SQLite format 3\u0000");
	expect(result.stagedRows).toBe(2);
	expect(result.beforeCommit).toBe(9);
	expect(result.restored).toEqual([1, 2, 3]);
	expect(result.sharedRead).toEqual([1, 2, 3]);
	expect(result.staleCas).toBe("SqliteStateConflictError");
	expect([...result.concurrentCas].sort()).toEqual([
		"SqliteStateConflictError",
		"committed",
	]);
	expect(result.reopened).toEqual([6, 7]);
	expect(result.resetCount).toBe(3);
	expect(externalRequests).toEqual([]);
});
