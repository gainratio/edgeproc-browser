// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import {
	type SqliteStateDatabaseHandle,
	type SqliteStateRuntime,
	SqliteStateStoreDatabase,
} from "./database";
import { createSqliteStateRuntime } from "./runtime";

const wasm = new Uint8Array(
	readFileSync(
		new URL("../vector/sqlite/assets/sqlite3.wasm", import.meta.url),
	),
);
const modulePromise = sqlite3InitModule({
	wasmBinary: wasm,
	print: () => undefined,
	printErr: () => undefined,
});

async function openStore(
	name = "state-test",
	initialSchemaVersion = 1,
): Promise<SqliteStateStoreDatabase> {
	const sqlite = await modulePromise;
	const raw = new sqlite.oo1.DB(":memory:");
	const runtime = createSqliteStateRuntime(sqlite, raw);
	return new SqliteStateStoreDatabase(
		{ name, initialSchemaVersion },
		runtime.database,
		runtime,
		false,
	);
}

describe("SqliteStateStoreDatabase", () => {
	it("stores defensive byte copies and applies one atomic epoch per batch", async () => {
		const store = await openStore();
		const input = new Uint8Array([1, 2, 3]);
		expect(
			await store.batch([
				{ type: "put", namespace: "profiles", key: "alice", value: input },
				{
					type: "put",
					namespace: "settings",
					key: "theme",
					value: new TextEncoder().encode("dark"),
				},
			]),
		).toEqual({ changed: 2, epoch: 1 });
		input[0] = 99;

		const row = await store.get("profiles", "alice");
		expect(row).toEqual({
			namespace: "profiles",
			key: "alice",
			value: new Uint8Array([1, 2, 3]),
			revision: 1,
		});
		if (row !== undefined) row.value[1] = 99;
		expect((await store.get("profiles", "alice"))?.value).toEqual(
			new Uint8Array([1, 2, 3]),
		);

		expect(
			await store.batch(
				[
					{ type: "delete", namespace: "missing", key: "row" },
					{
						type: "put",
						namespace: "profiles",
						key: "bob",
						value: new Uint8Array([4]),
					},
				],
				{ expectedEpoch: 1 },
			),
		).toEqual({ changed: 1, epoch: 2 });
		expect((await store.get("profiles", "bob"))?.revision).toBe(2);
		await store.dispose();
	});

	it("rejects stale compare-and-swap batches without partial writes", async () => {
		const store = await openStore();
		await store.put("scope", "existing", new Uint8Array([1]));

		await expect(
			store.batch(
				[
					{
						type: "put",
						namespace: "scope",
						key: "forbidden",
						value: new Uint8Array([2]),
					},
				],
				{ expectedEpoch: 0 },
			),
		).rejects.toMatchObject({ name: "SqliteStateConflictError" });
		expect(await store.get("scope", "forbidden")).toBeUndefined();
		expect((await store.runtimeInfo()).epoch).toBe(1);
		await store.dispose();
	});

	it("lists a bounded, stable page without exposing SQL", async () => {
		const store = await openStore();
		await store.batch(
			["alpha", "alpine", "beta"].map((key) => ({
				type: "put" as const,
				namespace: "items",
				key,
				value: new TextEncoder().encode(key),
			})),
		);

		const first = await store.list({
			namespace: "items",
			prefix: "al",
			limit: 1,
		});
		expect(first.rows.map(({ key }) => key)).toEqual(["alpha"]);
		expect(first.nextKey).toBe("alpha");
		const second = await store.list({
			namespace: "items",
			prefix: "al",
			...(first.nextKey === undefined ? {} : { afterKey: first.nextKey }),
			limit: 10,
		});
		expect(second.rows.map(({ key }) => key)).toEqual(["alpine"]);
		expect(second.nextKey).toBeUndefined();
		await store.dispose();
	});

	it("migrates schema and data atomically", async () => {
		const store = await openStore("migration", 3);
		await store.put("legacy", "row", new Uint8Array([1]));

		expect(
			await store.migrate({
				fromVersion: 3,
				toVersion: 4,
				expectedEpoch: 1,
				mutations: [
					{ type: "delete", namespace: "legacy", key: "row" },
					{
						type: "put",
						namespace: "current",
						key: "row",
						value: new Uint8Array([2]),
					},
				],
			}),
		).toEqual({ changed: 2, epoch: 2, schemaVersion: 4 });
		expect(await store.get("legacy", "row")).toBeUndefined();
		expect((await store.get("current", "row"))?.value).toEqual(
			new Uint8Array([2]),
		);
		await expect(
			store.migrate({
				fromVersion: 3,
				toVersion: 5,
				mutations: [],
			}),
		).rejects.toMatchObject({ name: "SqliteStateSchemaError" });
		await store.dispose();
	});

	it("exports real SQLite bytes and imports only after a validated stage", async () => {
		const source = await openStore("source", 2);
		await source.put("chat", "thread-1", new Uint8Array([7, 8, 9]));
		const bytes = await source.exportBytes();
		expect(new TextDecoder().decode(bytes.slice(0, 16))).toBe(
			"SQLite format 3\u0000",
		);

		const target = await openStore("target", 1);
		await target.put("old", "row", new Uint8Array([0]));
		const staged = await target.stageImport(bytes);
		expect(staged).toMatchObject({ schemaVersion: 2, epoch: 1, rowCount: 1 });
		expect(await target.get("old", "row")).toBeDefined();
		expect(await target.get("chat", "thread-1")).toBeUndefined();

		const imported = await target.commitImport(staged.stageId, {
			expectedEpoch: 1,
		});
		expect(imported).toEqual({ changed: 2, epoch: 2, schemaVersion: 2 });
		expect(await target.get("old", "row")).toBeUndefined();
		expect((await target.get("chat", "thread-1"))?.value).toEqual(
			new Uint8Array([7, 8, 9]),
		);
		expect(await target.checkIntegrity()).toEqual({ ok: true, message: "ok" });

		await expect(target.commitImport(staged.stageId)).rejects.toThrow(
			/staged import/i,
		);
		await source.dispose();
		await target.dispose();
	});

	it("refuses malformed or foreign SQLite imports without changing state", async () => {
		const store = await openStore();
		await store.put("safe", "row", new Uint8Array([1]));
		await expect(store.stageImport(new Uint8Array([1, 2, 3]))).rejects.toThrow(
			/SQLite database/i,
		);

		const sqlite = await modulePromise;
		const foreign = new sqlite.oo1.DB(":memory:");
		foreign.exec({ sql: "CREATE TABLE unrelated(value TEXT)" });
		const foreignRuntime = createSqliteStateRuntime(
			sqlite,
			foreign as unknown as SqliteStateDatabaseHandle,
		);
		const foreignBytes = foreignRuntime.exportBytes();
		foreign.close();
		await expect(store.stageImport(foreignBytes)).rejects.toThrow(
			/not an edgeproc state database/i,
		);
		expect(await store.get("safe", "row")).toBeDefined();
		await store.dispose();
	});

	it("resets rows atomically while preserving schema and reports runtime facts", async () => {
		const store = await openStore("runtime", 7);
		await store.put("scope", "row", new Uint8Array([1]));
		expect(await store.reset({ expectedEpoch: 1 })).toEqual({
			changed: 1,
			epoch: 2,
		});
		expect(await store.runtimeInfo()).toEqual({
			name: "runtime",
			sqliteVersion: "3.53.4",
			persistence: "memory",
			ownership: "isolated-worker",
			schemaVersion: 7,
			epoch: 2,
			rowCount: 0,
		});
		await store.dispose();
	});

	it("refuses an incompatible internal database format without overwriting it", async () => {
		const sqlite = await modulePromise;
		const raw = new sqlite.oo1.DB(":memory:");
		raw.exec({ sql: "PRAGMA application_id = 123; PRAGMA user_version = 9" });
		const runtime = createSqliteStateRuntime(sqlite, raw);
		expect(
			() =>
				new SqliteStateStoreDatabase(
					{ name: "future", initialSchemaVersion: 1 },
					runtime.database,
					runtime,
					false,
				),
		).toThrow(/unsupported SQLite state format/);
		expect(raw.selectObjects("PRAGMA application_id")[0]?.application_id).toBe(
			123,
		);
		raw.close();
	});

	it("rolls back a batch when SQLite rejects any mutation", async () => {
		const sqlite = await modulePromise;
		const raw = new sqlite.oo1.DB(":memory:");
		const runtime = createSqliteStateRuntime(sqlite, raw);
		const rejecting: SqliteStateRuntime = {
			...runtime,
			database: interceptDatabase(runtime.database, (sql, bind) => {
				if (sql.startsWith("INSERT") && bind?.[1] === "reject") {
					throw new Error("forced mutation failure");
				}
			}),
		};
		const store = new SqliteStateStoreDatabase(
			{ name: "rollback", initialSchemaVersion: 1 },
			rejecting.database,
			rejecting,
			false,
		);
		await expect(
			store.batch([
				{
					type: "put",
					namespace: "scope",
					key: "accepted-first",
					value: new Uint8Array([1]),
				},
				{
					type: "put",
					namespace: "scope",
					key: "reject",
					value: new Uint8Array([2]),
				},
			]),
		).rejects.toThrow(/forced mutation failure/);
		expect(await store.get("scope", "accepted-first")).toBeUndefined();
		expect((await store.runtimeInfo()).epoch).toBe(0);
		await store.dispose();
	});

	it("rejects invalid public inputs and keeps no-op epochs stable", async () => {
		const sqlite = await modulePromise;
		const invalidOptions = (options: {
			name: string;
			initialSchemaVersion: number;
			maxImportBytes?: number;
		}) => {
			const raw = new sqlite.oo1.DB(":memory:");
			const runtime = createSqliteStateRuntime(sqlite, raw);
			try {
				return new SqliteStateStoreDatabase(
					options,
					runtime.database,
					runtime,
					false,
				);
			} catch (error) {
				raw.close();
				throw error;
			}
		};
		expect(() => invalidOptions({ name: "", initialSchemaVersion: 1 })).toThrow(
			/store name/,
		);
		expect(() =>
			invalidOptions({ name: "x", initialSchemaVersion: 0 }),
		).toThrow(/positive safe integer/);
		expect(() =>
			invalidOptions({ name: "x", initialSchemaVersion: 1, maxImportBytes: 0 }),
		).toThrow(/maxImportBytes/);

		const store = await openStore();
		await expect(store.batch([])).resolves.toEqual({ changed: 0, epoch: 0 });
		await expect(store.delete("scope", "missing")).resolves.toEqual({
			changed: 0,
			epoch: 0,
		});
		await expect(store.reset()).resolves.toEqual({ changed: 0, epoch: 0 });
		await expect(store.list({ namespace: "", limit: 1 })).rejects.toThrow(
			/namespace/,
		);
		await expect(
			store.list({ namespace: "scope", prefix: "bad\0", limit: 1 }),
		).rejects.toThrow(/prefix/);
		await expect(store.list({ namespace: "scope", limit: 0 })).rejects.toThrow(
			/list limit/,
		);
		await expect(store.batch([], { expectedEpoch: -1 })).rejects.toThrow(
			/expected epoch/,
		);
		await expect(
			store.batch([
				{
					type: "put",
					namespace: "scope",
					key: "row",
					value: "not-bytes" as unknown as Uint8Array,
				},
			]),
		).rejects.toThrow(/Uint8Array/);
		await expect(
			store.migrate({ fromVersion: 1, toVersion: 1, mutations: [] }),
		).rejects.toThrow(/greater than source/);
		await expect(store.stageImport(new Uint8Array())).rejects.toThrow(
			/SQLite import/,
		);
		await store.discardImport("missing-stage");
		await store.dispose();
		await store.dispose();
		await expect(store.get("scope", "row")).rejects.toThrow(/disposed/);
	});
});

function interceptDatabase(
	database: SqliteStateRuntime["database"],
	beforeExec: (sql: string, bind: ReadonlyArray<unknown> | undefined) => void,
): SqliteStateRuntime["database"] {
	return {
		exec: (sql, bind) => {
			beforeExec(sql, bind);
			database.exec(sql, bind);
		},
		selectObjects: (sql, bind) => database.selectObjects(sql, bind),
		transaction: (callback) => database.transaction(callback),
		close: () => database.close(),
	};
}

describe("SqliteStateStoreDatabase memory profile wiring", () => {
	it("applies the requested profile when the store opens", async () => {
		const sqlite = await modulePromise;
		const raw = new sqlite.oo1.DB(":memory:");
		const runtime = createSqliteStateRuntime(sqlite, raw);
		new SqliteStateStoreDatabase(
			{ name: "profiled", initialSchemaVersion: 1, memoryProfile: "lite" },
			runtime.database,
			runtime,
			false,
		);
		expect(
			runtime.database.selectObjects("PRAGMA cache_size")[0]?.cache_size,
		).toBe(-16384);
		expect(
			runtime.database.selectObjects("PRAGMA soft_heap_limit")[0]
				?.soft_heap_limit,
		).toBe(48 * 1024 * 1024);
	});
});
