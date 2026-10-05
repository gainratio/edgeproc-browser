// @vitest-environment node
//
// A consumer's SQL test suite, run against the PACKED artefact: `npm pack`
// the package, unpack it into a scratch project's node_modules, and run a
// plain-Node script that imports `@gainratio/browser/sql/node`. This proves
// the subpath is exported, packed (wasm included) and loads under native ESM
// with nothing from this repository's source tree.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { packedFiles } from "./npm-pack-json";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "edgeproc-sql-node-consumer-"));

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

const CONSUMER = `
import { openNodeSqlDatabase } from "@gainratio/browser/sql/node";

const db = await openNodeSqlDatabase({ name: "consumer" });
await db.exec(\`
	CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
	CREATE TABLE events(id INTEGER PRIMARY KEY, customer_id INTEGER);
	CREATE TRIGGER events_no_update BEFORE UPDATE ON events
	BEGIN SELECT RAISE(ABORT, 'append-only'); END;
\`);
const id = await db.transaction(async (tx) => {
	const { lastInsertRowid } = await tx.exec(
		"INSERT INTO customers(name) VALUES (?)", ["Ada"]);
	await tx.exec("INSERT INTO events(customer_id) VALUES (?)", [lastInsertRowid]);
	return lastInsertRowid;
});
const copy = await openNodeSqlDatabase({ name: "copy" });
await copy.importDatabase(await db.exportDatabase(), { allowTriggersAndViews: true });
const refused = await copy.exec("UPDATE events SET customer_id = 0").then(
	() => "accepted", (error) => error.message);
const info = await copy.runtimeInfo();
console.log(JSON.stringify({
	id,
	rows: await copy.query("SELECT c.name, e.id AS event FROM customers c JOIN events e ON e.customer_id = c.id"),
	refused,
	sqlite: info.sqliteVersion,
	vector: info.vectorVersion,
}));
await Promise.all([db.close(), copy.close()]);
`;

describe("@gainratio/browser/sql/node from a packed tarball", () => {
	it("is packed with its wasm and runs a consumer's SQL against the real engine", () => {
		const { filename, files } = packedFiles(
			JSON.parse(
				execFileSync(
					"npm",
					["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
					{ cwd: ROOT, encoding: "utf8" },
				),
			),
			"@gainratio/browser",
		);
		for (const required of [
			"dist/sql/node.js",
			"dist/sql/node.d.ts",
			"dist/sql/nodeRuntime.js",
			"dist/vector/sqlite/assets/sqlite3.wasm",
			"dist/vector/sqlite/assets/sqlite3.mjs",
		]) {
			expect(files, `${required} is not in the tarball`).toContain(required);
		}

		const project = join(scratch, "consumer");
		const installed = join(project, "node_modules", "@gainratio", "browser");
		mkdirSync(installed, { recursive: true });
		execFileSync("tar", [
			"-xzf",
			join(scratch, filename),
			"-C",
			installed,
			"--strip-components=1",
		]);
		writeFileSync(join(project, "package.json"), '{ "type": "module" }');
		writeFileSync(join(project, "sql.test.mjs"), CONSUMER);

		const output = execFileSync(process.execPath, ["sql.test.mjs"], {
			cwd: project,
			encoding: "utf8",
		});
		expect(JSON.parse(output)).toEqual({
			id: 1,
			rows: [{ name: "Ada", event: 1 }],
			refused: expect.stringMatching(/append-only$/),
			sqlite: "3.53.4",
			vector: "1.1.2",
		});
	}, 60_000);
});
