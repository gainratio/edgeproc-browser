// The /seal entry is a seam: `age-encryption` is imported by exactly one
// production module, only with a dynamic import, and never from the main entry.
// That keeps the library swappable in one file and keeps its ~53 KB gzip out of
// apps that never seal.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function walk(dir: string, keep: (file: string) => boolean): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) return walk(full, keep);
		return keep(full) ? [full] : [];
	});
}

describe("seal seam", () => {
	it("only src/seal/age.ts imports age-encryption in production source", () => {
		const importers = walk(
			join(ROOT, "src"),
			(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
		)
			.filter((f) => readFileSync(f, "utf8").includes('"age-encryption"'))
			.map((f) => relative(ROOT, f));
		expect(importers).toEqual(["src/seal/age.ts"]);
	});

	it("loads age-encryption lazily: no static import in the built module", () => {
		const built = readFileSync(join(ROOT, "dist/seal/age.js"), "utf8");
		expect(built).toContain('import("age-encryption")');
		expect(built).not.toMatch(/^\s*import\s[^(]*["']age-encryption["']/m);
	});

	it("keeps the main entry free of the seal module", () => {
		const reachable = walk(join(ROOT, "dist"), (f) => f.endsWith(".js"))
			.filter((f) => !f.includes(`${join("dist", "seal")}`))
			.filter((f) => /age-encryption|\/seal\//.test(readFileSync(f, "utf8")));
		expect(reachable).toEqual([]);
	});

	it("exports ./seal from package.json", () => {
		const pkg = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		) as {
			exports: Record<string, unknown>;
			dependencies: Record<string, string>;
		};
		expect(pkg.exports["./seal"]).toEqual({
			types: "./dist/seal/index.d.ts",
			import: "./dist/seal/index.js",
		});
		expect(pkg.dependencies["age-encryption"]).toMatch(/^\^0\.3\./);
	});

	it("exposes the documented API from the built entry", async () => {
		const seal = (await import(join(ROOT, "dist/seal/index.js"))) as Record<
			string,
			unknown
		>;
		for (const name of [
			"checkNewPassphrase",
			"sealWithPassphrase",
			"openWithPassphrase",
			"isSealed",
			"openLegacyPbkdf2AesGcm",
		]) {
			expect(typeof seal[name], name).toBe("function");
		}
		expect(seal.DEFAULT_SCRYPT_WORK_FACTOR).toBe(17);
		expect(seal.DEFAULT_MIN_PASSPHRASE_LENGTH).toBe(12);
	});
});
