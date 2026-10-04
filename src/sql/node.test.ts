// @vitest-environment node
//
// The supported Node entry: the SAME pinned SQLite build, the same client and
// the same Worker-side handler, run in-process so a consumer's SQL tests run
// against the real engine instead of a fake.

import { describe, expect, it, vi } from "vitest";
import { openNodeSqlDatabase } from "./node";
import { initInProcessSqlite } from "./nodeRuntime";
import { SqlImportRejectedError } from "./types";

describe("openNodeSqlDatabase", () => {
	it("runs the pinned build in-process: FTS5, JSON1 and sqlite-vector on one connection", async () => {
		const db = await openNodeSqlDatabase({ name: "node-entry" });
		expect(db.name).toBe("node-entry");
		expect(db.storage).toEqual({ persistence: "memory", reason: "requested" });

		const info = await db.runtimeInfo();
		expect(info).toMatchObject({
			sqliteVersion: "3.53.4",
			vectorVersion: "1.1.2",
			fts5: true,
			json1: true,
		});

		await db.exec(`
			CREATE TABLE docs(id INTEGER PRIMARY KEY, body TEXT);
			CREATE VIRTUAL TABLE docs_fts USING fts5(body, content='docs', content_rowid='id');
		`);
		await db.executeMany("INSERT INTO docs VALUES (?, ?)", [
			[1, "red shoes"],
			[2, "blue coat"],
		]);
		await db.exec("INSERT INTO docs_fts(docs_fts) VALUES ('rebuild')");
		expect(
			await db.query(
				"SELECT rowid AS id FROM docs_fts WHERE docs_fts MATCH 'red'",
			),
		).toEqual([{ id: 1 }]);
		await db.close();
		await expect(db.query("SELECT 1")).rejects.toThrow(/closed/);
	});

	it("gives every call its own database, and applies the memory profile asked for", async () => {
		const a = await openNodeSqlDatabase({
			name: "a",
			memoryProfile: "minimal",
		});
		const b = await openNodeSqlDatabase({ name: "b" });
		await a.exec("CREATE TABLE only_in_a(x)");
		expect(
			await b.query(
				"SELECT count(*) AS n FROM sqlite_schema WHERE name = 'only_in_a'",
			),
		).toEqual([{ n: 0 }]);
		expect((await a.runtimeInfo()).memoryProfile.tier).toBe("minimal");
		await Promise.all([a.close(), b.close()]);
	});

	it("copies values across the seam like postMessage does", async () => {
		const db = await openNodeSqlDatabase({ name: "clone" });
		const blob = new Uint8Array([1, 2, 3]);
		await db.exec("CREATE TABLE b(v BLOB)");
		// Changed after the call returns but before the "Worker" runs it: a
		// postMessage copy was taken at the call, so the change must not show.
		const inserting = db.exec("INSERT INTO b VALUES (?)", [blob]);
		blob[0] = 9;
		await inserting;
		const [row] = await db.query<{ v: Uint8Array }>("SELECT v FROM b");
		expect([...(row?.v ?? [])]).toEqual([1, 2, 3]);
		await db.close();
	});

	it("does not leak the OPFS auto-install warning or the location shim", async () => {
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const before = Object.getOwnPropertyDescriptor(globalThis, "location");
		try {
			const db = await openNodeSqlDatabase({ name: "quiet" });
			await db.close();
			expect(error).not.toHaveBeenCalled();
			expect(Object.getOwnPropertyDescriptor(globalThis, "location")).toEqual(
				before,
			);
		} finally {
			error.mockRestore();
		}
	});

	it("moves a schema with triggers (the workstation's append-only pair) only with allowTriggersAndViews", async () => {
		const source = await openNodeSqlDatabase({ name: "workstation" });
		await source.exec(`
			CREATE TABLE customers(customer_id TEXT PRIMARY KEY);
			CREATE TABLE match_events(id INTEGER PRIMARY KEY, customer_id TEXT NOT NULL);
			CREATE TRIGGER match_events_no_update BEFORE UPDATE ON match_events
			BEGIN SELECT RAISE(ABORT, 'match_events is append-only: UPDATE is refused'); END;
			CREATE TRIGGER match_events_no_delete BEFORE DELETE ON match_events
			WHEN EXISTS (SELECT 1 FROM customers WHERE customer_id = OLD.customer_id)
			BEGIN SELECT RAISE(ABORT, 'match_events is append-only: DELETE is refused while the customer exists'); END;
			INSERT INTO customers VALUES ('c1');
			INSERT INTO match_events VALUES (1, 'c1');
		`);
		const bytes = await source.exportDatabase();
		const target = await openNodeSqlDatabase({ name: "restored" });

		const refused = await target.importDatabase(bytes).catch((e: unknown) => e);
		expect(refused).toBeInstanceOf(SqlImportRejectedError);
		expect(refused).toMatchObject({ reason: "unsafe-schema" });

		await target.importDatabase(bytes, { allowTriggersAndViews: true });
		expect(
			await target.query(
				"SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name",
			),
		).toEqual([
			{ name: "match_events_no_delete" },
			{ name: "match_events_no_update" },
		]);
		await expect(
			target.exec("UPDATE match_events SET customer_id = 'c2'"),
		).rejects.toThrow(/UPDATE is refused/);
		await expect(target.exec("DELETE FROM match_events")).rejects.toThrow(
			/DELETE is refused/,
		);
		await Promise.all([source.close(), target.close()]);
	});

	it("restores a host's own location after initialising", async () => {
		const own = { configurable: true, value: { href: "https://host.test/" } };
		Object.defineProperty(globalThis, "location", own);
		try {
			const db = await openNodeSqlDatabase({ name: "hosted" });
			await db.close();
			expect(Object.getOwnPropertyDescriptor(globalThis, "location")).toEqual({
				...own,
				enumerable: false,
				writable: false,
			});
		} finally {
			delete (globalThis as { location?: unknown }).location;
		}
	});

	it("rejects a bad wasm binary without blocking the next initialisation", async () => {
		await expect(
			initInProcessSqlite(new Uint8Array([0, 1, 2, 3])),
		).rejects.toThrow();
		const db = await openNodeSqlDatabase({ name: "after-failure" });
		expect(await db.query("SELECT 1 AS one")).toEqual([{ one: 1 }]);
		await db.close();
	});

	it("refuses OPFS-only operations with a plain error", async () => {
		const db = await openNodeSqlDatabase({ name: "no-opfs" });
		await expect(
			db.migrateLegacySahPool({ fromPool: "old", fromFile: "/old.sqlite3" }),
		).rejects.toThrow(/browser SQL Worker/);
		await db.close();
	});
});
