// @vitest-environment node
// SQLite is the only store for data. This guard fails the build if shipped
// source reaches for IndexedDB, localStorage or sessionStorage anywhere except
// the one-time 0.2.x migration reader, and fails if that reader ever writes.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = dirname(SRC);
const MIGRATION_READER = "engine/legacyStores.ts";
const FORBIDDEN =
	/\bindexedDB\b|\bIDBFactory\b|\blocalStorage\b|\bsessionStorage\b|idb-keyval/u;

function shippedSources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "__fixtures__" || entry.name === "assets"
				? []
				: shippedSources(path);
		}
		return /\.(?:ts|mts|js|mjs)$/u.test(entry.name) &&
			!/\.test\.ts$/u.test(entry.name)
			? [path]
			: [];
	});
}

/** Strip comments so prose that NAMES IndexedDB is not a use of it. */
function code(path: string): string {
	return readFileSync(path, "utf8")
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

describe("storage guard: SQLite is the only system of record", () => {
	it("no shipped module uses IndexedDB, localStorage or sessionStorage", () => {
		const offenders = shippedSources(SRC)
			.filter((path) => relative(SRC, path) !== MIGRATION_READER)
			.filter((path) => FORBIDDEN.test(code(path)))
			.map((path) => relative(SRC, path));
		expect(offenders).toEqual([]);
	});

	it("the migration reader only reads and deletes IndexedDB", () => {
		const reader = code(join(SRC, MIGRATION_READER));
		expect(reader).not.toMatch(
			/\.(?:put|add)\(|createObjectStore|localStorage|sessionStorage/u,
		);
	});

	it("the package does not depend on an IndexedDB wrapper", () => {
		const pkg = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		) as {
			dependencies?: Record<string, string>;
		};
		expect(Object.keys(pkg.dependencies ?? {})).not.toContain("idb-keyval");
	});
});
