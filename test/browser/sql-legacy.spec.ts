import { expect, test } from "@playwright/test";

// Chromium, Firefox and WebKit. Playwright's WebKit refuses the OPFS root, so
// there the typed refusal is the outcome (nothing to migrate into).
const ROWS = 2_000;

test("legacy opfs-sahpool: held pool is in-use, hot journal recovered, row-identical copy, removal on request", async ({
	page,
	browserName,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/test/browser/sql-legacy-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const proof = await page.evaluate(
		([name, rows]) => window.runLegacyProof(name, rows),
		[`legacy-${crypto.randomUUID()}`, ROWS] as const,
	);

	if (browserName === "webkit") {
		expect(proof).toEqual({ refused: "opfs-unavailable" });
		return;
	}
	// CONTRACT REVERSED in 0.3.0. This used to assert the defect: 3.53.4's
	// sahpool never treated its journal as hot, so reading through it saw the
	// torn write. With the backported xCheckReservedLock (patch 0002) this
	// build's sahpool rolls the hot journal back itself.
	expect(proof.direct).toMatchObject({
		files: expect.arrayContaining(["/kyc.sqlite3", "/kyc.sqlite3-journal"]),
	});
	expect((proof.direct as { first: string }).first).toBe("kept-");

	expect(proof.whileHeld).toEqual({ status: "in-use" });
	expect(proof.migrated).toMatchObject({
		status: "migrated",
		recoveredJournal: true,
		legacy: "removed",
	});
	expect(proof.rows).toBe(ROWS);
	expect(proof.prefixes).toEqual(["kept-"]);
	expect(proof.identical).toBe(true);
	expect(proof.afterRemoval).toEqual({ status: "absent" });
	expect(errors).toEqual([]);
});
