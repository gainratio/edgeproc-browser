// @vitest-environment node
//
// dist/ is committed and is what consumers install, so CI must prove it is
// exactly what src/ builds to. `pnpm gate` runs verify:dist, but tsc never
// deletes outputs: a source file removed from src/ would leave its stale build
// committed in dist/ and the gate would stay green. The explicit CI step
// rebuilds from an EMPTY dist/, so a stale file shows up as a deletion.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url);
const ci = readFileSync(new URL(".github/workflows/ci.yml", ROOT), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
	scripts: Record<string, string>;
};

describe("CI proves committed dist/ matches src/", () => {
	it("has a step that rebuilds dist/ from scratch and fails on any difference", () => {
		const step = ci
			.split(/\n\s*- name: /)
			.find((block) => block.startsWith("Verify committed dist/ matches src/"));
		expect(step, "ci.yml has no dist/ verification step").toBeDefined();
		const run = step ?? "";
		expect(run).toMatch(/rm -rf dist/);
		expect(run.indexOf("rm -rf dist")).toBeLessThan(run.indexOf("pnpm build"));
		expect(run.indexOf("pnpm build")).toBeLessThan(
			run.indexOf("pnpm verify:dist"),
		);
	});

	it("verify:dist compares the build to what is committed", () => {
		expect(pkg.scripts["verify:dist"]).toBe("node scripts/verify-dist.mjs");
		const script = readFileSync(
			new URL("scripts/verify-dist.mjs", ROOT),
			"utf8",
		);
		expect(script).toMatch(
			/"status",\s*"--porcelain",\s*"--untracked-files=all"/,
		);
		expect(script).toMatch(/process\.exit\(1\)/);
	});
});
