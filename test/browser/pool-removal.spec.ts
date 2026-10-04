import { expect, test } from "@playwright/test";

// Regression for main 18372c6 (run 37225186415): removeOpfsPool right after
// dispose() reported "in-use" because dispose resolved before the Worker had
// released the pool's sync access handles. 50 rounds, no sleeps, no retries.
test("close then remove is deterministic: 50 rounds, every one removed", async ({
	page,
}) => {
	test.setTimeout(240_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/test/browser/sql-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const rounds = 50;
	const name = `close-remove-${crypto.randomUUID()}`;
	const result = await page.evaluate(
		([n, r]) => window.runCloseThenRemove(n, r),
		[name, rounds] as const,
	);

	expect(result.vector).toEqual(Array(rounds).fill("removed"));
	expect(result.sql).toEqual(Array(rounds).fill("removed"));
	expect(errors).toEqual([]);
});

test("a pool another live tab holds is in-use, and survives the attempt", async ({
	context,
}) => {
	test.setTimeout(60_000);
	const owner = await context.newPage();
	const remover = await context.newPage();
	for (const page of [owner, remover]) {
		await page.goto("/test/browser/sql-fixture.html");
		await expect(page.locator("#ready")).toHaveText("ready");
	}
	const name = `held-${crypto.randomUUID()}`;
	await owner.evaluate((n) => window.holdVectorPool(n), name);

	expect(await remover.evaluate((n) => window.removeVectorPool(n), name)).toBe(
		"in-use",
	);
	expect(await owner.evaluate(() => window.heldVectorCount())).toBe(1);

	await owner.evaluate(() => window.releaseVectorPool());
	expect(await remover.evaluate((n) => window.removeVectorPool(n), name)).toBe(
		"removed",
	);
});
