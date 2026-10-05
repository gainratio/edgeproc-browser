import { expect, test } from "@playwright/test";

// open → kill the Worker mid-close → reopen, 25 rounds: the pool keeps every
// slot and every write finds room for its journal. Runs in Chromium and
// Firefox; in WebKit only where OPFS is available (Playwright's WebKit
// refuses the OPFS root).
const ROUNDS = 25;

test("opfs-sahpool keeps its slots across 25 reloads that kill the Worker mid-close", async ({
	page,
	browserName,
}) => {
	test.setTimeout(180_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (/SAH pool is full/i.test(message.text())) errors.push(message.text());
	});
	await page.goto("/test/browser/sahpool-reload-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	const opfs = await page.evaluate(() => window.opfsAvailable());
	test.skip(
		!opfs && browserName === "webkit",
		"this WebKit build refuses the OPFS root",
	);
	expect(opfs).toBe(true);

	const proof = await page.evaluate(
		([name, rounds]) => window.runSahPoolReloadProof(name, rounds),
		[`reload-${crypto.randomUUID()}`, ROUNDS] as const,
	);
	console.log(
		`${browserName}: initial slots ${proof.initialSlots}, per round ${JSON.stringify(proof.rounds.map((r) => r.slots))}`,
	);
	expect(proof.storage).toBe("opfs");
	expect(proof.rounds.filter((r) => r.error !== null)).toEqual([]);
	expect(proof.rounds.map((r) => r.slots)).toEqual(
		Array.from({ length: ROUNDS }, () => proof.initialSlots),
	);
	// Seed table plus two rows per round: nothing lost to a deleted slot.
	expect(proof.rows).toBe(ROUNDS * 2);
	expect(errors).toEqual([]);
});
