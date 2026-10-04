// @vitest-environment node
//
// Export / import of a whole SQLite database, proven on the SAME pinned build
// the Worker ships. Export is sqlite3_serialize; import validates the bytes in
// a scratch connection, then replaces the live database in ONE transaction.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import { loadNodeSqlite, type NodeSqlite } from "./__fixtures__/nodeSqlite";
import { SqlEngine } from "./engine";
import { createHead } from "./portable";
import type { SqlSerializer } from "./serializer";
import { SqlImportRejectedError, type SqlImportRejection } from "./types";

let sqlite: NodeSqlite;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
});

function open(): SqlEngine {
	return new SqlEngine(sqlite.openMemory(), {
		storage: { persistence: "memory", reason: "requested" },
		memoryProfile: MEMORY_PROFILES.lite,
		serializer: sqlite.serializer,
	});
}

const APP_ID = 0x414c4d41; // "ALMA"
/** The fixture has a trigger and a view, so it must opt in to them. */
const TRUSTED = { allowTriggersAndViews: true } as const;

/** A database with every object kind an app is likely to have. */
function seedSource(): SqlEngine {
	const db = open();
	db.exec(`
		PRAGMA application_id = ${APP_ID};
		PRAGMA user_version = 3;
		CREATE TABLE products(id INTEGER PRIMARY KEY, title TEXT NOT NULL, embedding BLOB);
		CREATE TABLE notes(body TEXT, at REAL);
		CREATE TABLE tags(name TEXT PRIMARY KEY, n INTEGER) WITHOUT ROWID;
		CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT,
			shout TEXT GENERATED ALWAYS AS (upper(what)) VIRTUAL);
		CREATE VIRTUAL TABLE products_fts USING fts5(title, content='products', content_rowid='id');
		CREATE INDEX notes_at ON notes(at);
		CREATE VIEW red AS SELECT id, title FROM products WHERE title LIKE '%red%';
		CREATE TRIGGER products_audit AFTER INSERT ON products BEGIN
			INSERT INTO audit(what) VALUES ('insert ' || new.id);
		END;
	`);
	db.executeMany("INSERT INTO products VALUES (?, ?, ?)", [
		[1, "red running shoes", new Float32Array([1, 0, 0])],
		[2, "blue rain jacket", new Float32Array([0, 1, 0])],
		[7, "red wool scarf", new Float32Array([0.9, 0.1, 0])],
	]);
	db.exec("INSERT INTO products_fts(products_fts) VALUES ('rebuild')");
	// Non-contiguous rowids: a copy that renumbers rowids is a different table.
	db.executeMany("INSERT INTO notes(rowid, body, at) VALUES (?, ?, ?)", [
		[5, "first", 1.5],
		[9, null, 2.25],
	]);
	db.executeMany("INSERT INTO tags VALUES (?, ?)", [
		["sale", 2],
		["new", 1],
	]);
	db.exec("DELETE FROM audit WHERE seq = 3");
	return db;
}

function userTables(db: SqlEngine): string[] {
	return db
		.query(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_stat%' ORDER BY name",
		)
		.map((row) => String(row.name));
}

/** Every table's rows (rowid included where there is one), in a stable order. */
function contents(db: SqlEngine): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const table of userTables(db)) {
		const withoutRowid =
			db.query("SELECT wr FROM pragma_table_list WHERE name = ?", [table])[0]
				?.wr === 1;
		const select = withoutRowid ? "*" : "rowid AS __rowid, *";
		out[table] = db.query(
			`SELECT ${select} FROM "${table}" ORDER BY ${withoutRowid ? "1" : "rowid"}`,
		);
	}
	return out;
}

function schema(db: SqlEngine) {
	return db.query(
		"SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
	);
}

function header(db: SqlEngine) {
	return {
		applicationId: db.query("PRAGMA application_id")[0]?.application_id,
		userVersion: db.query("PRAGMA user_version")[0]?.user_version,
	};
}

/** The target app's own data, which a rejected import must leave untouched. */
function seedTarget(): SqlEngine {
	const db = open();
	db.exec(`
		PRAGMA application_id = ${APP_ID};
		PRAGMA user_version = 3;
		CREATE TABLE products(id INTEGER PRIMARY KEY, title TEXT NOT NULL, embedding BLOB);
		CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
		INSERT INTO products(id, title) VALUES (40, 'old product');
		INSERT INTO settings VALUES ('theme', 'dark');
	`);
	return db;
}

function snapshot(db: SqlEngine) {
	return { schema: schema(db), contents: contents(db), header: header(db) };
}

/**
 * Overwrite schema text inside the FILE, same length, the way a hand-crafted
 * backup would: SQLite still opens it (it parses only the first statement).
 */
function patchSchemaText(bytes: Uint8Array, from: string, to: string) {
	expect(to.length).toBeLessThanOrEqual(from.length);
	const needle = new TextEncoder().encode(from);
	const replacement = new TextEncoder().encode(to.padEnd(from.length, " "));
	const at = bytes.findIndex((_, index) =>
		needle.every((value, offset) => bytes[index + offset] === value),
	);
	expect(at).toBeGreaterThan(0);
	const patched = bytes.slice();
	patched.set(replacement, at);
	return patched;
}

function rejection(action: () => unknown): SqlImportRejection | "accepted" {
	try {
		action();
		return "accepted";
	} catch (error) {
		if (error instanceof SqlImportRejectedError) return error.reason;
		throw error;
	}
}

describe("exportDatabase / importDatabase on the pinned build", () => {
	it("round-trips a database row for row: rowids, blobs, FTS5, views, triggers, header", () => {
		const source = seedSource();
		const bytes = source.exportDatabase();
		expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe(
			"SQLite format 3",
		);

		const target = seedTarget();
		const result = target.importDatabase(bytes, {
			expectedSchema: { applicationId: APP_ID, userVersion: 3 },
			allowTriggersAndViews: true,
		});

		expect(result).toEqual({
			byteLength: bytes.byteLength,
			applicationId: APP_ID,
			userVersion: 3,
		});
		expect(snapshot(target)).toEqual(snapshot(source));
		expect(userTables(target)).not.toContain("settings");
		// The imported objects WORK, not just exist: FTS5, view, trigger, sequence.
		expect(
			target.query(
				"SELECT rowid FROM products_fts WHERE products_fts MATCH 'red' ORDER BY rowid",
			),
		).toEqual([{ rowid: 1 }, { rowid: 7 }]);
		expect(target.query("SELECT id FROM red ORDER BY id")).toEqual([
			{ id: 1 },
			{ id: 7 },
		]);
		target.exec("INSERT INTO products(id, title) VALUES (8, 'green')");
		expect(
			target.query(
				"SELECT seq, what, shout FROM audit ORDER BY seq DESC LIMIT 1",
			),
		).toEqual([{ seq: 4, what: "insert 8", shout: "INSERT 8" }]);
		expect(target.query("PRAGMA integrity_check")).toEqual([
			{ integrity_check: "ok" },
		]);
		// Export of the imported database is byte-for-byte content-equal again.
		const again = open();
		again.importDatabase(target.exportDatabase(), {
			allowTriggersAndViews: true,
		});
		expect(contents(again)).toEqual(contents(target));
	});

	it("rejects bytes that are not a SQLite database and leaves the target intact", () => {
		const target = seedTarget();
		const before = snapshot(target);
		const text = new TextEncoder().encode('{"not":"sqlite"}'.repeat(64));
		expect(rejection(() => target.importDatabase(text))).toBe("not-sqlite");
		expect(rejection(() => target.importDatabase(new Uint8Array(0)))).toBe(
			"not-sqlite",
		);
		expect(snapshot(target)).toEqual(before);
	});

	it("rejects a corrupt file (valid header, damaged b-tree) via integrity_check", () => {
		const bytes = seedSource().exportDatabase();
		const pageSize = new DataView(bytes.buffer).getUint16(16);
		const corrupt = bytes.slice();
		// Smash the cell area of every page after the schema page.
		for (let page = 1; page * pageSize < corrupt.byteLength; page++) {
			corrupt.fill(0xa5, page * pageSize + 8, page * pageSize + 64);
		}
		const target = seedTarget();
		const before = snapshot(target);
		expect(rejection(() => target.importDatabase(corrupt))).toBe("corrupt");
		expect(snapshot(target)).toEqual(before);
	});

	it("rejects a truncated file (a whole page, and a partial page)", () => {
		const bytes = seedSource().exportDatabase();
		const pageSize = new DataView(bytes.buffer).getUint16(16);
		const target = seedTarget();
		const before = snapshot(target);
		expect(
			rejection(() =>
				target.importDatabase(bytes.slice(0, bytes.length - pageSize)),
			),
		).toBe("corrupt");
		expect(
			rejection(() =>
				target.importDatabase(bytes.slice(0, bytes.length - 100)),
			),
		).toBe("corrupt");
		// Partial page AND a stale in-header size (so only the length check sees it).
		const stale = bytes.slice(0, bytes.length - 100);
		stale[95] = (stale[95] ?? 0) ^ 0xff;
		expect(rejection(() => target.importDatabase(stale))).toBe("corrupt");
		expect(snapshot(target)).toEqual(before);
	});

	it("rejects a file SQLite can read but whose index disagrees with its table", () => {
		const source = open();
		source.exec(`
			CREATE TABLE t(a TEXT);
			CREATE INDEX t_a ON t(a);
			INSERT INTO t VALUES ('zzzzzzzzzzzzzzzz');
		`);
		// The first copy of the text is the table row (page 2), not the index.
		const skewed = patchSchemaText(
			source.exportDatabase(),
			"zzzzzzzzzzzzzzzz",
			"yyyyyyyyyyyyyyyy",
		);
		const target = seedTarget();
		const before = snapshot(target);
		expect(rejection(() => target.importDatabase(skewed))).toBe("corrupt");
		expect(snapshot(target)).toEqual(before);
	});

	it("rejects another application's database and an unsupported schema version", () => {
		const bytes = seedSource().exportDatabase();
		const target = seedTarget();
		const before = snapshot(target);
		expect(
			rejection(() =>
				target.importDatabase(bytes, {
					...TRUSTED,
					expectedSchema: { applicationId: APP_ID + 1 },
				}),
			),
		).toBe("foreign-application");
		expect(
			rejection(() =>
				target.importDatabase(bytes, {
					...TRUSTED,
					expectedSchema: { userVersion: 2 },
				}),
			),
		).toBe("unsupported-version");
		expect(
			rejection(() =>
				target.importDatabase(bytes, {
					...TRUSTED,
					expectedSchema: { userVersion: { min: 4 } },
				}),
			),
		).toBe("unsupported-version");
		expect(
			rejection(() =>
				target.importDatabase(bytes, {
					...TRUSTED,
					expectedSchema: { userVersion: { max: 2 } },
				}),
			),
		).toBe("unsupported-version");
		expect(
			target.importDatabase(bytes, {
				...TRUSTED,
				expectedSchema: { userVersion: { min: 1, max: 3 } },
			}).userVersion,
		).toBe(3);
		expect(snapshot(target)).not.toEqual(before);
	});

	it("runs the caller's SQL checks against the incoming file, read-only", () => {
		const bytes = seedSource().exportDatabase();
		const target = seedTarget();
		const before = snapshot(target);
		expect(
			rejection(() =>
				target.importDatabase(bytes, {
					...TRUSTED,
					expectedSchema: {
						checks: [
							"SELECT count(*) = 3 FROM products",
							"SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE name = 'settings')",
						],
					},
				}),
			),
		).toBe("check-failed");
		// A check cannot write: the scratch connection is query_only.
		expect(
			rejection(() =>
				target.importDatabase(bytes, {
					...TRUSTED,
					expectedSchema: { checks: ["DELETE FROM products RETURNING 1"] },
				}),
			),
		).toBe("check-failed");
		expect(snapshot(target)).toEqual(before);
		target.importDatabase(bytes, {
			...TRUSTED,
			expectedSchema: { checks: ["SELECT count(*) = 3 FROM products"] },
		});
		expect(target.query("SELECT count(*) AS n FROM products")).toEqual([
			{ n: 3 },
		]);
	});

	it("rejects a schema row that smuggles a second statement; the live DB is untouched", () => {
		const source = open();
		const padded = `CREATE TABLE x(a /*${"A".repeat(40)}*/)`;
		source.exec(padded);
		const smuggled = patchSchemaText(
			source.exportDatabase(),
			padded,
			"CREATE TABLE x(a);DROP TABLE settings;",
		);
		const target = seedTarget();
		const before = snapshot(target);
		expect(rejection(() => target.importDatabase(smuggled))).toBe("corrupt");
		expect(snapshot(target)).toEqual(before);
		// Same file without the smuggled statement imports fine.
		target.importDatabase(source.exportDatabase());
		expect(userTables(target)).toContain("x");
	});

	it("rejects triggers and views unless the caller opts in", () => {
		const withTrigger = open();
		withTrigger.exec(`
			CREATE TABLE t(a);
			CREATE TRIGGER t_spy AFTER INSERT ON t BEGIN DELETE FROM t; END;
		`);
		const withView = open();
		withView.exec("CREATE TABLE t(a); CREATE VIEW v AS SELECT a FROM t");
		const target = seedTarget();
		const before = snapshot(target);
		expect(
			rejection(() => target.importDatabase(withTrigger.exportDatabase())),
		).toBe("unsafe-schema");
		expect(
			rejection(() => target.importDatabase(withView.exportDatabase())),
		).toBe("unsafe-schema");
		expect(snapshot(target)).toEqual(before);
		target.importDatabase(withTrigger.exportDatabase(), {
			allowTriggersAndViews: true,
		});
		expect(
			target.query("SELECT name FROM sqlite_schema WHERE type = 'trigger'"),
		).toEqual([{ name: "t_spy" }]);
	});

	it("allows only listed virtual-table modules (fts5 by default)", () => {
		const source = open();
		const padded = "CREATE VIRTUAL TABLE docs USING fts5(body)";
		source.exec(padded);
		const bytes = source.exportDatabase();
		const target = seedTarget();
		expect(
			rejection(() =>
				target.importDatabase(bytes, { virtualTableModules: ["rtree"] }),
			),
		).toBe("unsafe-schema");
		target.importDatabase(bytes);
		expect(userTables(target)).toContain("docs");
	});

	it("is not fooled by 'USING fts5' inside a quoted name or a comment", () => {
		const target = seedTarget();
		const before = snapshot(target);
		for (const smuggle of [
			`CREATE VIRTUAL TABLE "evil USING fts5(x)" USING fts5vocab(docs, 'row')`,
			"CREATE VIRTUAL TABLE evil /* USING fts5(x) */ USING fts5vocab(docs, 'row')",
		]) {
			const source = open();
			source.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
			source.exec(smuggle);
			expect(
				rejection(() => target.importDatabase(source.exportDatabase())),
			).toBe("unsafe-schema");
		}
		expect(snapshot(target)).toEqual(before);
	});

	it("rejects a comment in a CREATE head even when the module is allowed", () => {
		const source = open();
		source.exec("CREATE VIRTUAL TABLE docs /* hi */ USING fts5(body)");
		const target = seedTarget();
		expect(
			rejection(() => target.importDatabase(source.exportDatabase())),
		).toBe("unsafe-schema");
	});

	it("rejects schema-qualified names (main., temp.) in CREATE rows", () => {
		const target = seedTarget();
		const reasons: string[] = [];
		const before = snapshot(target);
		for (const [original, qualified] of [
			// Same name, same length: only the qualifier differs.
			["CREATE TABLE f     (a)", "CREATE TABLE main.f(a)"],
			["CREATE TABLE f     (a)", "CREATE TABLE temp.f(a)"],
			["CREATE INDEX h      ON t(a)", "CREATE INDEX temp.h ON t(a)"],
			[
				"CREATE TRIGGER g      AFTER INSERT ON t BEGIN SELECT 1; END",
				"CREATE TRIGGER main.g AFTER INSERT ON t BEGIN SELECT 1; END",
			],
			[
				"CREATE TRIGGER g      AFTER INSERT ON t BEGIN SELECT 1; END",
				"CREATE TRIGGER temp.g AFTER INSERT ON t BEGIN SELECT 1; END",
			],
		] as const) {
			const source = open();
			source.exec("CREATE TABLE t(a)");
			source.exec(original);
			const bytes = patchSchemaText(
				source.exportDatabase(),
				original,
				qualified,
			);
			reasons.push(rejection(() => target.importDatabase(bytes, TRUSTED)));
		}
		// SQLite itself refuses to load a qualified name ("malformed database
		// schema"), so these files never reach our own parse. See createHead.
		expect(reasons).toEqual(Array(5).fill("corrupt"));
		expect(snapshot(target)).toEqual(before);
	});

	it("leaves trusted_schema OFF on the live connection after an import", () => {
		const target = seedTarget();
		target.exec("PRAGMA trusted_schema = ON");
		target.importDatabase(seedTarget().exportDatabase());
		expect(target.query("PRAGMA trusted_schema")).toEqual([
			{ trusted_schema: 0 },
		]);
	});

	it("a check that returns no rows fails", () => {
		const bytes = seedSource().exportDatabase();
		expect(
			rejection(() =>
				seedTarget().importDatabase(bytes, {
					...TRUSTED,
					expectedSchema: { checks: ["SELECT 1 WHERE 0"] },
				}),
			),
		).toBe("check-failed");
	});

	it("replaces a database that already has triggers, views, FTS5 and a sequence", () => {
		const target = seedSource();
		target.exec("INSERT INTO audit(what) VALUES ('local only')");
		const other = open();
		other.exec("CREATE TABLE fresh(a); INSERT INTO fresh VALUES (1)");
		target.importDatabase(other.exportDatabase());
		// SQLite never lets sqlite_sequence be dropped; it is left empty.
		const withoutSequence = (db: SqlEngine) => {
			const { schema: rows, contents: tables, header: h } = snapshot(db);
			const { sqlite_sequence: sequence = [], ...rest } = tables as Record<
				string,
				unknown
			>;
			return {
				schema: rows.filter((row) => row.name !== "sqlite_sequence"),
				contents: rest,
				header: h,
				sequence,
			};
		};
		expect(withoutSequence(target)).toEqual(withoutSequence(other));
		// And back again: the sequence and every object return exactly.
		const source = seedSource();
		target.importDatabase(source.exportDatabase(), TRUSTED);
		expect(snapshot(target)).toEqual(snapshot(source));
	});

	it("rejects a virtual table SQLite cannot open with only the allowed modules", () => {
		// Stands in for a parse that disagreed with SQLite: the cross-check
		// alone must refuse it.
		const dropEverything: SqlSerializer = {
			...sqlite.serializer,
			keepOnlyModules: (raw) => sqlite.serializer.keepOnlyModules(raw, []),
		};
		const target = new SqlEngine(sqlite.openMemory(), {
			storage: { persistence: "memory", reason: "requested" },
			memoryProfile: MEMORY_PROFILES.lite,
			serializer: dropEverything,
		});
		const source = open();
		source.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
		expect(
			rejection(() => target.importDatabase(source.exportDatabase())),
		).toBe("unsafe-schema");
	});

	it("exports a database with no pages as SQLite's own empty file", () => {
		const noPages: SqlSerializer = {
			...sqlite.serializer,
			serialize: (raw) =>
				raw === bare ? new Uint8Array(0) : sqlite.serializer.serialize(raw),
		};
		const bare = sqlite.openMemory();
		const engine = new SqlEngine(bare, {
			storage: { persistence: "memory", reason: "requested" },
			memoryProfile: MEMORY_PROFILES.lite,
			serializer: noPages,
		});
		const bytes = engine.exportDatabase();
		expect(new TextDecoder().decode(bytes.subarray(0, 15))).toBe(
			"SQLite format 3",
		);
		open().importDatabase(bytes);
	});

	it("serializer: surfaces sqlite3_deserialize failures and handles without a pointer", () => {
		const raw = sqlite.openMemory();
		const bytes = open().exportDatabase();
		expect(() =>
			sqlite.serializer.deserialize(raw, "nope", bytes, true),
		).toThrow(/sqlite3_deserialize failed/);
		const { pointer: _pointer, ...withoutPointer } = {
			pointer: undefined,
			exec: raw.exec.bind(raw),
			selectObjects: raw.selectObjects.bind(raw),
			prepare: raw.prepare.bind(raw),
			transaction: raw.transaction.bind(raw),
			close: raw.close.bind(raw),
		};
		expect(() => sqlite.serializer.serialize(withoutPointer)).toThrow(
			/no native pointer/,
		);
	});

	it("refuses an import over the size limit before reading it", () => {
		const bytes = seedSource().exportDatabase();
		const target = seedTarget();
		expect(
			rejection(() =>
				target.importDatabase(bytes, { maxBytes: bytes.byteLength - 1 }),
			),
		).toBe("too-large");
	});

	it("an import that fails MID-WAY (disk full) rolls back and leaves the original intact", () => {
		const source = open();
		source.exec("CREATE TABLE big(id INTEGER PRIMARY KEY, payload BLOB)");
		source.executeMany(
			"INSERT INTO big VALUES (?, randomblob(4000))",
			Array.from({ length: 200 }, (_, i) => [i]),
		);
		const bytes = source.exportDatabase();

		const target = seedTarget();
		const before = snapshot(target);
		const pages = Number(target.query("PRAGMA page_count")[0]?.page_count);
		// Room for the target, not for the import: SQLITE_FULL part-way through
		// the copy, AFTER the old tables were dropped inside the transaction.
		target.exec(`PRAGMA max_page_count = ${pages + 20}`);
		expect(() => target.importDatabase(bytes)).toThrow(/full/i);
		expect(snapshot(target)).toEqual(before);
		expect(target.query("PRAGMA integrity_check")).toEqual([
			{ integrity_check: "ok" },
		]);
		// No scratch schema is left attached after a failure.
		expect(
			target
				.query("SELECT name FROM pragma_database_list")
				.map((row) => row.name),
		).not.toContain("edgeproc_import");
	});

	it("exports an empty database as a valid, importable SQLite file", () => {
		const empty = open();
		const bytes = empty.exportDatabase();
		expect(bytes.byteLength).toBeGreaterThanOrEqual(512);
		const target = seedTarget();
		target.importDatabase(bytes);
		expect(userTables(target)).toEqual(userTables(empty));
		expect(userTables(target)).not.toContain("settings");
	});

	it("needs the serializer the Worker provides", () => {
		const bare = new SqlEngine(sqlite.openMemory(), {
			storage: { persistence: "memory", reason: "requested" },
			memoryProfile: MEMORY_PROFILES.lite,
		});
		expect(() => bare.exportDatabase()).toThrow(/serializ/);
		expect(() => bare.importDatabase(new Uint8Array(512))).toThrow(/serializ/);
	});
});

describe("createHead: the anchored parse of a stored CREATE", () => {
	const head = (type: string, name: string, sql: string) =>
		createHead({ type, name, sql });

	it("accepts each plain form, quoted or bare, and reads the module", () => {
		expect(head("table", "t", "CREATE TABLE t(a)")).toEqual({});
		expect(head("table", "x_data", "CREATE TABLE 'x_data'(id)")).toEqual({});
		expect(
			head("table", 'a"b', 'CREATE TABLE IF NOT EXISTS "a""b"(c)'),
		).toEqual({});
		expect(head("index", "i", "CREATE UNIQUE INDEX [i] ON t(a)")).toEqual({});
		expect(head("view", "v", "CREATE VIEW `v` AS SELECT 1")).toEqual({});
		expect(
			head(
				"trigger",
				"g",
				"CREATE TRIGGER g AFTER INSERT ON t BEGIN SELECT 1; END",
			),
		).toEqual({});
		expect(
			head("table", "d", "CREATE VIRTUAL TABLE d USING FTS5(body)"),
		).toEqual({ module: "fts5" });
	});

	it("refuses schema-qualified names", () => {
		// The qualifier spelled as the name too, so the name check alone passes.
		for (const [type, name, sql] of [
			["table", "main", "CREATE TABLE main.main(a)"],
			["table", "temp", 'CREATE TABLE "temp"."temp"(a)'],
			["index", "temp", "CREATE INDEX temp.temp ON t(a)"],
			["view", "main", "CREATE VIEW main . main AS SELECT 1"],
			[
				"trigger",
				"temp",
				"CREATE TRIGGER temp.temp AFTER INSERT ON t BEGIN SELECT 1; END",
			],
		] as const) {
			expect(head(type, name, sql), sql).toBeUndefined();
		}
		for (const [type, sql] of [
			["table", "CREATE TABLE main.f(a)"],
			["table", "CREATE TABLE temp . f(a)"],
			["table", 'CREATE TABLE "main"."f"(a)'],
			["index", "CREATE INDEX temp.f ON t(a)"],
			["view", "CREATE VIEW main.f AS SELECT 1"],
			[
				"trigger",
				"CREATE TRIGGER temp.f AFTER INSERT ON t BEGIN SELECT 1; END",
			],
			["table", "CREATE VIRTUAL TABLE main.f USING fts5(a)"],
		] as const) {
			expect(head(type, "f", sql), sql).toBeUndefined();
		}
	});

	it("refuses TEMP, comments in the head, and a name that is not the row's", () => {
		expect(head("table", "f", "CREATE TEMP TABLE f(a)")).toBeUndefined();
		expect(
			head(
				"trigger",
				"f",
				"CREATE TEMP TRIGGER f AFTER INSERT ON t BEGIN SELECT 1; END",
			),
		).toBeUndefined();
		expect(head("table", "f", "CREATE TABLE /* x */ f(a)")).toBeUndefined();
		expect(head("table", "f", "CREATE TABLE g(a)")).toBeUndefined();
		expect(head("table", "f", "CREATE VIEW f AS SELECT 1")).toBeUndefined();
		expect(head("index", "f", "CREATE TABLE f(a)")).toBeUndefined();
		expect(head("trigger", "f", "DROP TABLE f")).toBeUndefined();
		expect(head("unknown", "f", "CREATE TABLE f(a)")).toBeUndefined();
	});

	it("reads the module from the grammar, not from a quoted name or comment", () => {
		expect(
			head(
				"table",
				"evil USING fts5(x)",
				`CREATE VIRTUAL TABLE "evil USING fts5(x)" USING fts5vocab(docs, 'row')`,
			),
		).toEqual({ module: "fts5vocab" });
		expect(
			head(
				"table",
				"evil",
				"CREATE VIRTUAL TABLE evil /* USING fts5(x) */ USING fts5vocab(docs)",
			),
		).toBeUndefined();
	});
});
