import { expect, test } from "@playwright/test";

// Runs in every Playwright project (chromium, firefox, webkit). Each browser
// states its OWN storage outcome: a browser that refuses OPFS must say so
// through the typed fallback, never by skipping. Playwright's WebKit refuses
// the OPFS root ("UnknownError"), so there the fallback path IS the proof.
const OPFS = { persistence: "opfs" } as const;
const REFUSED = {
	persistence: "memory",
	reason: "opfs-unavailable",
} as const;

const EXPECTED = {
	chromium: { opfs: true, deviceMemory: "number" },
	firefox: { opfs: true, deviceMemory: "undefined" },
	webkit: { opfs: false, deviceMemory: "undefined" },
} as const;

const ROWS = [
	{ id: 1, title: "red running shoes" },
	{ id: 2, title: "blue rain jacket" },
	{ id: 3, title: "red wool scarf" },
];

test("cross-browser: OPFS or typed fallback, SQL round trip, export/import, memory profile", async ({
	page,
	browserName,
}) => {
	const expected = EXPECTED[browserName];
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/test/browser/cross-browser-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const name = `xb-${crypto.randomUUID()}`;
	const result = await page.evaluate(
		(n) => window.runCrossBrowserProof(n),
		name,
	);

	// OPFS open, or the typed refusal and the memory fallback it reports.
	if (expected.opfs) {
		expect(result.strictOpen).toMatchObject(OPFS);
		expect(result.fallbackStorage).toMatchObject(OPFS);
		expect(result.secondTab).toMatchObject({
			persistence: "memory",
			reason: "pool-in-use",
		});
		expect(result.reopenedRows).toBe(1);
		expect(result.removals).toEqual(["removed", "absent"]);
	} else {
		expect(result.strictOpen).toEqual({ refused: "opfs-unavailable" });
		expect(result.fallbackStorage).toMatchObject(REFUSED);
		expect(result.secondTab).toMatchObject(REFUSED);
		// Memory is not persistence: nothing survives the close.
		expect(result.reopenedRows).toBe(0);
		expect(result.removals).toEqual(Array(2).fill("refused:opfs-unavailable"));
	}
	expect(result.requested).toEqual({
		persistence: "memory",
		reason: "requested",
	});

	// The SQL seam round trip, FTS5 included, in this browser's Worker.
	expect(result.rows).toEqual(ROWS);
	expect(result.fts).toEqual([1, 3]);

	// Export is a SQLite file; import reproduces it; damage is refused, typed.
	expect(result.exportHeader).toBe("SQLite format 3");
	expect(result.importedRows).toEqual(ROWS);
	expect(result.corrupt).toBe("corrupt");

	// MemoryProfile: Firefox and Safari have no navigator.deviceMemory, and
	// unknown memory must never earn "full". The Worker agrees with the page.
	expect(result.deviceMemoryType).toBe(expected.deviceMemory);
	expect(result.workerTier).toBe(result.detectedTier);
	if (expected.deviceMemory === "undefined") {
		expect(result.workerTier).toBe("lite");
	}
	expect(errors).toEqual([]);
});
