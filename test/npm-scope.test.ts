// The package publishes as @gainratio/browser. The retired @edgeproc scope must
// not creep back into anything that decides what gets published.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const WORKFLOWS = readdirSync(join(ROOT, ".github/workflows"))
	.filter((name) => name.endsWith(".yml"))
	.map((name) => `.github/workflows/${name}`);

describe("npm scope", () => {
	it("publishes under @gainratio", () => {
		expect((JSON.parse(read("package.json")) as { name: string }).name).toBe(
			"@gainratio/browser",
		);
	});

	it("names no @edgeproc/ package in the manifest, tsconfig or workflows", () => {
		const surfaces = ["package.json", "tsconfig.json", ...WORKFLOWS];
		expect(WORKFLOWS.length).toBeGreaterThan(0);
		expect(
			surfaces.filter((path) => read(path).includes("@edgeproc/")),
		).toEqual([]);
	});

	it("points repository, homepage and bugs at gainratio/edgeproc-browser", () => {
		// npm provenance refuses a publish whose `repository` is not the repo the
		// workflow runs in, and the package now publishes from gainratio.
		const pkg = JSON.parse(read("package.json")) as {
			homepage: string;
			repository: { url: string };
			bugs: { url: string };
		};
		expect(pkg.repository.url).toBe(
			"git+https://github.com/gainratio/edgeproc-browser.git",
		);
		expect(pkg.homepage).toBe(
			"https://github.com/gainratio/edgeproc-browser#readme",
		);
		expect(pkg.bugs.url).toBe(
			"https://github.com/gainratio/edgeproc-browser/issues",
		);
	});
});
