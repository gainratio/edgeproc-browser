import { expect, test } from "@playwright/test";

test("SQLite export/import: OPFS + memory round trip, typed rejections, owner-lock serialization", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/test/browser/sql-portable-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const name = `portable-${crypto.randomUUID()}`;
	const result = await page.evaluate(
		(n) => window.runSqlPortableProof(n),
		name,
	);

	expect(result.exportHeader).toBe("SQLite format 3");
	expect(result.importedRows).toEqual(result.sourceRows);
	expect((result.sourceRows as unknown[]).length).toBe(203);
	expect(result.importedHybrid).toEqual([
		"red running shoes",
		"red wool scarf",
	]);
	expect(result.corrupt).toBe("corrupt");
	expect(result.foreign).toBe("foreign-application");
	expect(result.whileHeld).toBe("pool-in-use");
	expect(result.heldRowsAfter).toBe(203);
	expect(result.events).toEqual([
		"import holds lock",
		"import done",
		"writer opened",
	]);
	expect(result.writerRows).toEqual({ n: 204, top: 9999 });
	expect(result.memoryStorage).toBe("memory");
	expect(result.memoryRows).toEqual(result.sourceRows);
	expect(result.trustedSchema).toBe(0);
	expect(errors).toEqual([]);
});

// CI run 37230731318: on a slow runner the import by name held the owner lock
// longer than the writer's 1 s wait, and the writer failed "pool-in-use". A
// large import reproduces that on any machine: the writer must wait for it.
test("a writer opened during a long import by name waits for it", async ({
	page,
}) => {
	test.setTimeout(120_000);
	await page.goto("/test/browser/sql-portable-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	const result = await page.evaluate(
		(n) => window.runSlowImportWait(n, 64),
		`slow-import-${crypto.randomUUID()}`,
	);
	console.log(`import by name took ${result.importMs} ms`);
	expect(result.importMs).toBeGreaterThan(1_000);
	expect(result.writer).toBe("opened");
	expect(result.rows).toBe(64 * 16);
});
