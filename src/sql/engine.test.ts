// @vitest-environment node

import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { loadNodeSqlite, type NodeSqlite } from "./__fixtures__/nodeSqlite";
import { SqlEngine, type SqlRawDatabase, type SqlRawStatement } from "./engine";

let sqlite: NodeSqlite;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
});

const MEMORY = { persistence: "memory", reason: "requested" } as const;

function open(
	profile = MEMORY_PROFILES.lite,
	runtime: NodeSqlite = sqlite,
): SqlEngine {
	return new SqlEngine(runtime.openMemory(), {
		storage: MEMORY,
		memoryProfile: profile,
	});
}

/** A real connection whose statement lifecycle and transaction modes are recorded. */
function tracked(raw: SqlRawDatabase) {
	const log = {
		prepared: 0,
		finalized: 0,
		qualifiers: [] as string[],
		closed: false,
	};
	const wrap = (statement: SqlRawStatement): SqlRawStatement => ({
		bind: (values) => statement.bind(values),
		step: () => statement.step(),
		get: (target) => statement.get(target),
		reset: (clear) => statement.reset(clear),
		finalize: () => {
			log.finalized += 1;
			return statement.finalize();
		},
	});
	const db: SqlRawDatabase = {
		exec: (options) => raw.exec(options),
		selectObjects: (sql, bind) => raw.selectObjects(sql, bind),
		prepare: (sql) => {
			const statement = wrap(raw.prepare(sql));
			log.prepared += 1;
			return statement;
		},
		transaction: (qualifier, callback) => {
			log.qualifiers.push(qualifier);
			return raw.transaction(qualifier, callback);
		},
		close: () => {
			log.closed = true;
			raw.close();
		},
	};
	return { db, log };
}

/** A real connection with selected SQL answered by `answer` instead. */
function forged(
	raw: SqlRawDatabase,
	answer: (sql: string) => Array<Record<string, unknown>> | undefined,
): SqlRawDatabase {
	return {
		exec: (options) => raw.exec(options),
		prepare: (sql) => raw.prepare(sql),
		transaction: (qualifier, callback) => raw.transaction(qualifier, callback),
		close: () => raw.close(),
		selectObjects: (sql, bind) => answer(sql) ?? raw.selectObjects(sql, bind),
	};
}

/** A file-backed connection (Emscripten MEMFS, so the journal is real). */
async function openFile(name: string): Promise<SqlRawDatabase> {
	const module = await sqlite3InitModule({
		wasmBinary: new Uint8Array(
			await readFile(
				new URL("../vector/sqlite/assets/sqlite3.wasm", import.meta.url),
			),
		),
		print: () => undefined,
		printErr: () => undefined,
	});
	return new module.oo1.DB(`/${name}.sqlite3`) as unknown as SqlRawDatabase;
}

const OPFS = {
	persistence: "opfs",
	pool: "p",
	file: "/p.sqlite3",
} as const;

function vector(values: ReadonlyArray<number>): Float32Array {
	return new Float32Array(values);
}

describe("SqlEngine on the pinned SQLite build", () => {
	it("runs FTS5 bm25 and sqlite-vector on ONE connection, joined in one query", () => {
		const db = open();
		db.exec(`
			CREATE TABLE products(id INTEGER PRIMARY KEY, title TEXT NOT NULL, embedding BLOB);
			CREATE VIRTUAL TABLE products_fts USING fts5(title, content='products', content_rowid='id');
		`);
		db.executeMany(
			"INSERT INTO products(id, title, embedding) VALUES (?, ?, ?)",
			[
				[1, "red running shoes", vector([1, 0, 0])],
				[2, "blue rain jacket", vector([0, 1, 0])],
				[3, "red wool scarf", vector([0.9, 0.1, 0])],
			],
		);
		db.exec("INSERT INTO products_fts(products_fts) VALUES ('rebuild')");
		db.query(
			"SELECT vector_init('products', 'embedding', 'type=FLOAT32,dimension=3')",
		);

		const keyword = db.query(
			"SELECT rowid AS id, bm25(products_fts) AS score FROM products_fts WHERE products_fts MATCH ? ORDER BY score",
			["red"],
		);
		expect(keyword.map((row) => row.id)).toEqual(
			expect.arrayContaining([1, 3]),
		);
		expect(keyword).toHaveLength(2);
		expect(keyword.every((row) => (row.score as number) < 0)).toBe(true);

		const hybrid = db.query(
			`WITH kw AS (
				SELECT rowid AS id FROM products_fts WHERE products_fts MATCH :q
			), knn AS (
				SELECT rowid AS id, distance FROM vector_full_scan('products', 'embedding', :v, 3)
			)
			SELECT p.title FROM knn JOIN kw USING (id) JOIN products p ON p.id = knn.id
			ORDER BY knn.distance`,
			{ ":q": "red", ":v": vector([1, 0, 0]) },
		);
		expect(hybrid.map((row) => row.title)).toEqual([
			"red running shoes",
			"red wool scarf",
		]);

		const json = db.query("SELECT json_extract(?, '$.a.b') AS v", [
			'{"a":{"b":42}}',
		]);
		expect(json).toEqual([{ v: 42 }]);
		const info = db.runtimeInfo();
		expect(info.fts5).toBe(true);
		expect(info.json1).toBe(true);
		expect(info.sqliteVersion).toBe("3.53.4");
		expect(info.vectorVersion).toBe("1.1.2");
		db.close();
	});

	it("applies the memory profile's PRAGMAs on open", async () => {
		// Heap limits are per WASM instance and PRAGMA hard_heap_limit can only
		// lower them, so the lowest profile gets an instance of its own.
		const db = open(MEMORY_PROFILES.minimal, await loadNodeSqlite());
		const [cache] = db.query("PRAGMA cache_size");
		expect(cache?.cache_size).toBe(-MEMORY_PROFILES.minimal.cacheSizeKiB);
		const [heap] = db.query("PRAGMA hard_heap_limit");
		expect(heap?.hard_heap_limit).toBe(
			MEMORY_PROFILES.minimal.hardHeapLimitBytes,
		);
		expect(db.runtimeInfo().memoryProfile).toEqual(MEMORY_PROFILES.minimal);
		expect(db.runtimeInfo().storage).toEqual(MEMORY);
		db.close();
	});

	it("refuses a SQLite build other than the pinned one", () => {
		const raw = sqlite.openMemory();
		const forged: SqlRawDatabase = {
			...raw,
			exec: raw.exec.bind(raw),
			prepare: raw.prepare.bind(raw),
			transaction: raw.transaction.bind(raw),
			close: raw.close.bind(raw),
			selectObjects: (sql, bind) =>
				sql.includes("sqlite_version()")
					? [{ sqlite: "3.0.0", vector: "1.1.2", fts5: 1 }]
					: raw.selectObjects(sql, bind),
		};
		expect(
			() =>
				new SqlEngine(forged, {
					storage: MEMORY,
					memoryProfile: MEMORY_PROFILES.lite,
				}),
		).toThrow(/unexpected SQLite runtime/);
	});

	it.each([
		["no version row", []],
		["another sqlite-vector", [{ sqlite: "3.53.4", vector: "9.9.9", fts5: 1 }]],
		["no FTS5", [{ sqlite: "3.53.4", vector: "1.1.2", fts5: 0 }]],
	])("refuses a runtime with %s", (_label, row) => {
		const raw = forged(sqlite.openMemory(), (sql) =>
			sql.includes("sqlite_version()") ? row : undefined,
		);
		expect(
			() =>
				new SqlEngine(raw, {
					storage: MEMORY,
					memoryProfile: MEMORY_PROFILES.lite,
				}),
		).toThrow(/unexpected SQLite runtime/);
	});

	it("reports FTS5 and JSON1 as the connection answers, not as assumed", () => {
		let constructed = false;
		const raw = forged(sqlite.openMemory(), (sql) => {
			if (!constructed) return undefined;
			if (sql.includes("sqlite_version()")) {
				return [{ sqlite: "3.53.4", vector: "1.1.2", fts5: 0 }];
			}
			return sql.includes("json_valid") ? [{ ok: 0 }] : undefined;
		});
		const db = new SqlEngine(raw, {
			storage: MEMORY,
			memoryProfile: MEMORY_PROFILES.lite,
		});
		constructed = true;
		expect(db.runtimeInfo()).toMatchObject({ fts5: false, json1: false });
		db.close();
	});

	it("binds exec parameters", () => {
		const db = open();
		db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
		db.exec("INSERT INTO t(v) VALUES (?), (?)", ["a", "b"]);
		expect(db.query("SELECT v FROM t ORDER BY id")).toEqual([
			{ v: "a" },
			{ v: "b" },
		]);
		db.close();
	});

	it("finalizes every statement it prepares, and writes under BEGIN IMMEDIATE", () => {
		const { db: raw, log } = tracked(sqlite.openMemory());
		const db = new SqlEngine(raw, {
			storage: MEMORY,
			memoryProfile: MEMORY_PROFILES.lite,
		});
		db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
		db.query("SELECT 1");
		expect(() => db.query("SELECT * FROM missing")).toThrow(/no such table/);
		expect(() =>
			db.query("INSERT INTO t(v) VALUES (?) RETURNING id", [null]),
		).toThrow(/NOT NULL/);
		db.transaction([
			{ sql: "INSERT INTO t(v) VALUES (?)", bind: ["x"] },
			{ sql: "INSERT INTO t(v) VALUES (?)", rows: [["y"]] },
		]);
		expect(() =>
			db.transaction([{ sql: "INSERT INTO t(v) VALUES (NULL)" }]),
		).toThrow(/NOT NULL/);
		db.executeMany("INSERT INTO t(v) VALUES (?)", [["z"]]);
		const once = db.prepare("SELECT v FROM t");
		db.allPrepared(once);
		db.finalize(once);
		expect(log.finalized).toBe(log.prepared);
		expect(log.qualifiers).toEqual(["IMMEDIATE", "IMMEDIATE", "IMMEDIATE"]);

		db.prepare("SELECT v FROM t");
		expect(log.finalized).toBe(log.prepared - 1);
		db.close();
		expect(log.finalized).toBe(log.prepared);
		expect(log.closed).toBe(true);
	});

	it("reports changes and the last rowid from exec", () => {
		const db = open();
		db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
		expect(db.exec("INSERT INTO t(v) VALUES (?), (?)", ["a", "b"])).toEqual({
			changes: 2,
			lastInsertRowid: 2,
		});
		expect(db.exec("UPDATE t SET v = 'c'").changes).toBe(2);
		db.close();
	});

	it("commits a transaction atomically and rolls it ALL back on failure", () => {
		const db = open();
		db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
		const ok = db.transaction([
			{ sql: "INSERT INTO t(v) VALUES (?)", bind: ["x"] },
			{ sql: "INSERT INTO t(v) VALUES (?)", rows: [["y"], ["z"]] },
			{ sql: "SELECT v FROM t ORDER BY id" },
		]);
		expect(ok.changes).toBe(3);
		expect(ok.results).toEqual([[], [], [{ v: "x" }, { v: "y" }, { v: "z" }]]);
		expect(() =>
			db.transaction([
				{ sql: "INSERT INTO t(v) VALUES ('w')" },
				{ sql: "INSERT INTO t(v) VALUES (NULL)" },
			]),
		).toThrow(/NOT NULL/);
		expect(db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 3 }]);
		db.close();
	});

	it("bulk-loads with executeMany atomically", () => {
		const db = open();
		db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
		const rows = Array.from({ length: 1_000 }, (_, i) => [i, `v${i}`]);
		expect(db.executeMany("INSERT INTO t VALUES (?, ?)", rows).changes).toBe(
			1_000,
		);
		expect(() =>
			db.executeMany("INSERT INTO t VALUES (?, ?)", [
				[5_000, "ok"],
				[5_001, null],
			]),
		).toThrow(/NOT NULL/);
		expect(db.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 1_000 }]);
		db.close();
	});

	it("reuses a prepared statement until it is finalized", () => {
		const db = open();
		db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
		const insert = db.prepare("INSERT INTO t(v) VALUES (?)");
		const select = db.prepare("SELECT v FROM t WHERE id = :id");
		expect(db.runPrepared(insert, ["a"]).changes).toBe(1);
		expect(db.runPrepared(insert, ["b"]).lastInsertRowid).toBe(2);
		expect(db.allPrepared(select, { ":id": 2 })).toEqual([{ v: "b" }]);
		expect(db.allPrepared(select, { ":id": 9 })).toEqual([]);
		expect(db.allPrepared(select, { ":id": 2 })).toEqual([{ v: "b" }]);
		// Bindings are cleared after each run: unbound, :id is NULL.
		expect(db.allPrepared(select)).toEqual([]);
		db.finalize(insert);
		expect(() => db.runPrepared(insert, ["c"])).toThrow(
			/prepared statement .* is not open/,
		);
		db.close();
	});

	it("binds booleans, ArrayBuffers and typed arrays", () => {
		const db = open();
		const [row] = db.query("SELECT ? AS t, length(?) AS a, length(?) AS f", [
			true,
			new ArrayBuffer(4),
			new Float32Array([1, 2]),
		]);
		expect(row).toEqual({ t: 1, a: 4, f: 8 });
		db.close();
	});

	it("runs the docs/sql.md reciprocal-rank-fusion query as written", () => {
		const db = open();
		db.exec(`
			CREATE TABLE products(id INTEGER PRIMARY KEY, title TEXT NOT NULL, embedding BLOB);
			CREATE VIRTUAL TABLE products_fts USING fts5(title, content='products', content_rowid='id');
		`);
		db.transaction([
			{
				sql: "INSERT INTO products(id, title, embedding) VALUES (?, ?, ?)",
				rows: [
					[1, "red running shoes", vector([1, 0, 0])],
					[2, "blue rain jacket", vector([0, 1, 0])],
					[3, "red wool scarf", vector([0.9, 0.1, 0])],
				],
			},
			{ sql: "INSERT INTO products_fts(products_fts) VALUES ('rebuild')" },
		]);
		db.query(
			"SELECT vector_init('products', 'embedding', 'type=FLOAT32,dimension=3')",
		);
		const hits = db.query(
			`WITH kw AS (
				SELECT rowid AS id, row_number() OVER (ORDER BY bm25(products_fts)) AS r
				FROM products_fts WHERE products_fts MATCH :q
			), knn AS (
				SELECT rowid AS id, row_number() OVER (ORDER BY distance) AS r
				FROM vector_full_scan('products', 'embedding', :v, 10)
			), fused AS (
				SELECT id, sum(1.0 / (60 + r)) AS score
				FROM (SELECT * FROM kw UNION ALL SELECT * FROM knn) GROUP BY id
			)
			SELECT p.id, p.title, fused.score FROM fused JOIN products p USING (id)
			ORDER BY fused.score DESC LIMIT 5`,
			{ ":q": "red", ":v": vector([1, 0, 0]) },
		);
		expect(hits.map((row) => row.id)).toEqual([1, 3, 2]);
		db.close();
	});

	it("refuses to run on OPFS if the privacy PRAGMAs do not stick", () => {
		// An in-memory DB reports journal_mode "memory", never "delete".
		expect(
			() =>
				new SqlEngine(sqlite.openMemory(), {
					storage: { persistence: "opfs", pool: "p", file: "/p.sqlite3" },
					memoryProfile: MEMORY_PROFILES.lite,
				}),
		).toThrow(/privacy pragmas were not applied/);
	});

	it("turns on secure_delete with a DELETE journal for a persistent file", async () => {
		const db = new SqlEngine(await openFile("engine-privacy"), {
			storage: OPFS,
			memoryProfile: MEMORY_PROFILES.lite,
		});
		expect(db.query("PRAGMA secure_delete")).toEqual([{ secure_delete: 1 }]);
		expect(db.query("PRAGMA journal_mode")).toEqual([
			{ journal_mode: "delete" },
		]);
		db.close();
	});

	it("refuses a persistent file whose secure_delete does not stick", async () => {
		const raw = await openFile("engine-insecure");
		const ignoring: SqlRawDatabase = {
			...forged(raw, () => undefined),
			exec: (options) =>
				options.sql === "PRAGMA secure_delete = ON"
					? undefined
					: raw.exec(options),
		};
		expect(
			() =>
				new SqlEngine(ignoring, {
					storage: OPFS,
					memoryProfile: MEMORY_PROFILES.lite,
				}),
		).toThrow(/privacy pragmas were not applied/);
		raw.close();
	});
});

describe("SqlEngine interactive transaction primitives", () => {
	it("begins IMMEDIATE, commits, and treats a rollback with nothing open as done", () => {
		const engine = open();
		engine.exec("CREATE TABLE t(x)");
		engine.begin();
		engine.exec("INSERT INTO t VALUES (1)");
		engine.commit();
		engine.begin();
		engine.exec("INSERT INTO t VALUES (2)");
		engine.rollback();
		engine.rollback();
		expect(engine.query("SELECT x FROM t")).toEqual([{ x: 1 }]);
		expect(() => engine.commit()).toThrow(/no transaction is active/);
	});

	it("rethrows a rollback failure that is not 'no transaction'", () => {
		const raw = sqlite.openMemory();
		const failing: SqlRawDatabase = {
			exec: (options) => {
				if (options.sql === "ROLLBACK") throw new Error("disk I/O error");
				return raw.exec(options);
			},
			selectObjects: (sql, bind) => raw.selectObjects(sql, bind),
			prepare: (sql) => raw.prepare(sql),
			transaction: (qualifier, callback) =>
				raw.transaction(qualifier, callback),
			close: () => raw.close(),
		};
		const engine = new SqlEngine(failing, {
			storage: MEMORY,
			memoryProfile: MEMORY_PROFILES.lite,
		});
		expect(() => engine.rollback()).toThrow("disk I/O error");
	});
});
