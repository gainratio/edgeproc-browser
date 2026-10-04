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
