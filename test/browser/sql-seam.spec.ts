import { expect, test } from "@playwright/test";

test("the public SQL seam: one OPFS database with FTS5 + vectors, typed fallback, idempotent cleanup", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/test/browser/sql-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const name = `sql-${crypto.randomUUID()}`;
	const result = await page.evaluate((n) => window.runSqlSeamProof(n), name);

	expect(result.storage).toMatchObject({ persistence: "opfs" });
	expect(result.runtime).toEqual({
		sqliteVersion: "3.53.4",
		vectorVersion: "1.1.2",
		fts5: true,
		json1: true,
	});
	expect(result.profileApplied).toBe(true);
	expect(result.journalMode).toBe("delete");
	expect(result.hybrid).toEqual(["red running shoes", "red wool scarf"]);
	expect(result.secondTab).toMatchObject({
		persistence: "memory",
		reason: "pool-in-use",
	});
	expect(result.secondTabRefusal).toBe("pool-in-use");
	expect(result.removeWhileOpen).toBe("in-use");
	expect(result.reopenedStorage).toBe("opfs");
	expect(result.reopenedRows).toBe(3);
	expect(result.removals).toEqual(["removed", "absent"]);
	expect(result.vectorPoolRemovals).toEqual(["removed", "absent"]);
	expect(errors).toEqual([]);
});
