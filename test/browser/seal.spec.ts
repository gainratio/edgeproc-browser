import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const FIXTURES = "src/seal/__fixtures__/legacy";
const manifest = JSON.parse(
	readFileSync(
		join(import.meta.dirname, "../..", FIXTURES, "manifest.json"),
		"utf8",
	),
) as {
	fixtures: ReadonlyArray<{ file: string; format: string; passphrase: string }>;
};

// A ~5 MB payload at the default work factor (logN 17, 128 MiB of scrypt), in
// a Worker. The timings are printed and attached to the report; the assertion
// on them is only a loose ceiling so a slow CI runner does not flake.
test("seal and open in a Worker at the default work factor, plus every legacy format", async ({
	page,
}, testInfo) => {
	test.setTimeout(120_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto("/test/browser/seal-fixture.html");
	await expect(page.locator("#ready")).toHaveText("ready");

	const proof = await page.evaluate(
		(legacy) => window.runSealProof({ payloadBytes: 5 * 1024 * 1024, legacy }),
		manifest.fixtures.map((f) => ({
			url: `/${FIXTURES}/${f.file}`,
			passphrase: f.passphrase,
		})),
	);

	expect(proof.workFactor).toBe(17);
	expect(proof.isSealed).toBe(true);
	expect(proof.roundTrip).toBe(true);
	expect(proof.wrongPassphrase).toBe("wrong_passphrase_or_tampered");
	expect(proof.tampered).toBe("wrong_passphrase_or_tampered");
	expect(proof.legacy).toEqual(manifest.fixtures.map((f) => f.format));
	expect(proof.sealMs).toBeLessThan(30_000);
	expect(proof.openMs).toBeLessThan(30_000);
	expect(errors).toEqual([]);

	const timing = `${testInfo.project.name}: seal ${Math.round(proof.sealMs)} ms, open ${Math.round(proof.openMs)} ms (5 MiB, logN 17, ${proof.sealedBytes} bytes sealed)`;
	testInfo.annotations.push({ type: "seal-timing", description: timing });
	console.log(`[seal-timing] ${timing}`);
});
