// @vitest-environment node
//
// biome.json's `$schema` used to name a versioned URL (schemas/2.5.7). Every
// Dependabot bump of @biomejs/biome left it one version behind, and biome
// reports the mismatch on every `biome check`. Pointing it at the schema the
// installed package ships means the two can never drift.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url);
const LOCAL_SCHEMA = "./node_modules/@biomejs/biome/configuration_schema.json";

interface BiomeConfig {
	readonly $schema?: string;
}

const schemaOf = (json: string): string | undefined =>
	(JSON.parse(json) as BiomeConfig).$schema;

const tracksInstalledBiome = (schema: string | undefined): boolean =>
	schema === LOCAL_SCHEMA && existsSync(fileURLToPath(new URL(schema, ROOT)));

describe("biome.json $schema", () => {
	it("points at the schema the installed biome ships", () => {
		const config = readFileSync(
			fileURLToPath(new URL("biome.json", ROOT)),
			"utf8",
		);
		expect(tracksInstalledBiome(schemaOf(config))).toBe(true);
	});

	it.each([
		["a versioned URL", "https://biomejs.dev/schemas/2.5.7/schema.json"],
		["no schema at all", undefined],
		["a path to nothing", "./node_modules/@biomejs/biome/missing.json"],
	])("rejects %s", (_label, schema) => {
		expect(tracksInstalledBiome(schema)).toBe(false);
	});
});
