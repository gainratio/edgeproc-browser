import { expect, type Page, test } from "@playwright/test";
import type { HotJournalProof } from "./hot-journal-fixture.js";

// A Worker killed mid-transaction must leave a hot journal that the next open
// rolls back, on both opfs-sahpool data paths. Runs in Chromium and Firefox;
// in WebKit only where OPFS is available (Playwright's WebKit refuses the OPFS
// root, and the typed memory fallback has no journal to recover).
const ROUNDS = 20;

async function open(page: Page, browserName: string): Promise<string[]> {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/test/browser/hot-journal-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");
	const opfs = await page.evaluate(() => window.opfsAvailable());
	test.skip(
		!opfs && browserName === "webkit",
		"this WebKit build refuses the OPFS root",
	);
	expect(opfs).toBe(true);
	return errors;
}

function tally(proof: HotJournalProof): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const round of proof.rounds) {
		counts[round.outcome] = (counts[round.outcome] ?? 0) + 1;
	}
	// The per-run evidence: how many of the rounds rolled back.
	console.log(`${test.info().title}: ${JSON.stringify(counts)}`);
	return counts;
}

test("/sql: a Worker killed mid-transaction is rolled back on reopen, 20 of 20", async ({
	page,
	browserName,
}) => {
	test.setTimeout(120_000);
	const errors = await open(page, browserName);
	const proof = await page.evaluate(
		([name, rounds]) => window.runSqlHotJournalProof(name, rounds),
		[`crash-${crypto.randomUUID()}`, ROUNDS] as const,
	);
	expect(proof.storage).toBe("opfs");
	// The kill always lands inside the open transaction, so the only correct
	// outcome is a full rollback: every row back on generation 0, a+b=100.
	expect({
		tally: tally(proof),
		torn: proof.rounds.filter((r) => r.outcome !== "rolled-back"),
	}).toEqual({
		tally: { "rolled-back": ROUNDS },
		torn: [],
	});
	for (const round of proof.rounds) expect(round.integrity).toBe("ok");
	expect(errors).toEqual([]);
});

test("/vector/sqlite: a hot journal in the index's file is rolled back by the vector Worker, 20 of 20", async ({
	page,
	browserName,
}) => {
	test.setTimeout(120_000);
	const errors = await open(page, browserName);
	const proof = await page.evaluate(
		([name, rounds]) => window.runVectorHotJournalProof(name, rounds),
		[`crash-${crypto.randomUUID()}`, ROUNDS] as const,
	);
	expect({
		tally: tally(proof),
		torn: proof.rounds.filter((r) => r.outcome !== "rolled-back"),
	}).toEqual({ tally: { "rolled-back": ROUNDS }, torn: [] });
	expect(errors).toEqual([]);
});
