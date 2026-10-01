// The package publishes as @gainratio/browser. The retired @edgeproc scope must
// not creep back into anything that decides what gets published.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
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
});
