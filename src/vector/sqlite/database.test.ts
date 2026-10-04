// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertVectorIndexConformance } from "../conformance";
import type { VectorIndexFactory } from "../types";
import sqlite3InitModule from "./assets/sqlite3.mjs";
import { type SqliteDatabase, SqliteDatabaseVectorIndex } from "./database";

interface RawDatabase {
	exec(options: { sql: string; bind?: unknown[] }): unknown;
	selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
	transaction<T>(callback: () => T): T;
	close(): void;
}

const wasm = new Uint8Array(
	readFileSync(new URL("./assets/sqlite3.wasm", import.meta.url)),
);
const modulePromise = sqlite3InitModule({
	wasmBinary: wasm,
	print: () => undefined,
	printErr: () => undefined,
});

async function openMemoryDatabase(): Promise<SqliteDatabase> {
	const sqlite = await modulePromise;
	const raw: RawDatabase = new sqlite.oo1.DB(":memory:");
	return {
		exec: (sql, bind) => {
			raw.exec(bind === undefined ? { sql } : { sql, bind: [...bind] });
		},
		selectObjects: (sql, bind) =>
			raw.selectObjects(sql, bind === undefined ? undefined : [...bind]),
		transaction: (callback) => raw.transaction(callback),
		close: () => raw.close(),
	};
}

function observeSelects(database: SqliteDatabase): {
	readonly database: SqliteDatabase;
	readonly vectorFullScanCount: () => number;
} {
	let vectorFullScanCount = 0;
	return {
		database: {
			exec: (sql, bind) => database.exec(sql, bind),
			selectObjects: (sql, bind) => {
				if (sql.includes("vector_full_scan")) {
					vectorFullScanCount += 1;
				}
				return database.selectObjects(sql, bind);
			},
			transaction: (callback) => database.transaction(callback),
			close: () => database.close(),
		},
		vectorFullScanCount: () => vectorFullScanCount,
	};
}

const factory: VectorIndexFactory = async (options) =>
	new SqliteDatabaseVectorIndex(options, await openMemoryDatabase(), false);

describe("SqliteDatabaseVectorIndex", () => {
	it("satisfies the reusable contract against the shipped WASM", async () => {
		await expect(
			assertVectorIndexConformance(factory),
		).resolves.toBeUndefined();
	});

	it("ships only the pinned vector extension", async () => {
		const index = new SqliteDatabaseVectorIndex(
			{ name: "runtime", dimension: 3 },
			await openMemoryDatabase(),
			false,
		);
		expect(index.runtimeInfo()).toEqual({
			sqliteVersion: "3.53.4",
			vectorVersion: "1.1.2",
			vectorBackend: "CPU",
			bundledExtensions: ["vector_version"],
		});
		await index.dispose();
	});

	it("binds adversarial metadata keys and values instead of interpolating them", async () => {
		const index = new SqliteDatabaseVectorIndex(
			{ name: "parameters", dimension: 2 },
			await openMemoryDatabase(),
			false,
		);
		const key = `tenant') OR 1=1 --`;
		const value = `a'); DROP TABLE edgeproc_vectors; --`;
		await index.insert([
			{
				id: "safe",
				vector: new Float32Array([1, 0]),
				metadata: { [key]: value },
			},
			{
				id: "other",
				vector: new Float32Array([1, 0]),
				metadata: { [key]: "other" },
			},
		]);

		expect(
			(await index.search(new Float32Array([1, 0]), 10, { [key]: value })).map(
				({ id }) => id,
			),
		).toEqual(["safe"]);
		expect((await index.stats()).vectorCount).toBe(2);
		await index.dispose();
	});

	it("uses one vector scan to score a bounded 2,000-id record batch", async () => {
		const observed = observeSelects(await openMemoryDatabase());
		const index = new SqliteDatabaseVectorIndex(
			{ name: "named-batch", dimension: 2 },
			observed.database,
			false,
		);
		await index.insert([
			{
				id: "near",
				vector: new Float32Array([1, 0]),
				metadata: {},
			},
			{
				id: "far",
				vector: new Float32Array([0, 1]),
				metadata: {},
			},
		]);

		const ids = [
			...Array.from({ length: 1_998 }, (_, index) => `missing-${index}`),
			"far",
			"near",
			"near",
		];
		expect(
			(await index.searchByIds(new Float32Array([1, 0]), ids)).map(
				({ id }) => id,
			),
		).toEqual(["near", "far"]);
		expect(observed.vectorFullScanCount()).toBe(1);
		await index.dispose();
	});

	it("indexes generic lookup keys with namespace isolation, stable order, and a strict document-frequency cap", async () => {
		const index = new SqliteDatabaseVectorIndex(
			{ name: "lookup", dimension: 2 },
			await openMemoryDatabase(),
			false,
		);
		await index.insertKeyed([
			{
				id: "first",
				vector: new Float32Array([1, 0]),
				metadata: {},
				lookupKeys: [
					{ namespace: "token", value: "shared" },
					{ namespace: "phonetic", value: "A150" },
				],
			},
			{
				id: "second",
				vector: new Float32Array([0, 1]),
				metadata: {},
				lookupKeys: [
					{ namespace: "token", value: "shared" },
					{ namespace: "token", value: "rare" },
				],
			},
			{
				id: "third",
				vector: new Float32Array([0.5, 0.5]),
				metadata: {},
				lookupKeys: [{ namespace: "token", value: "rare" }],
			},
		]);

		expect(
			await index.lookupIds(
				[
					{ namespace: "token", value: "rare" },
					{ namespace: "phonetic", value: "A150" },
					{ namespace: "token", value: "rare" },
				],
				2,
			),
		).toEqual(["second", "third", "first"]);
		expect(
			await index.lookupIds([{ namespace: "token", value: "shared" }], 1),
		).toEqual([]);
		expect(
			await index.lookupIds([{ namespace: "other", value: "shared" }], 10),
		).toEqual([]);
		await index.dispose();
	});

	it("replaces and cascades lookup keys with their vector record", async () => {
		const index = new SqliteDatabaseVectorIndex(
			{ name: "lookup-lifecycle", dimension: 2 },
			await openMemoryDatabase(),
			false,
		);
		await index.insertKeyed([
			{
				id: "row",
				vector: new Float32Array([1, 0]),
				metadata: {},
				lookupKeys: [{ namespace: "token", value: "old" }],
			},
		]);
		await index.insertKeyed([
			{
				id: "row",
				vector: new Float32Array([0, 1]),
				metadata: {},
				lookupKeys: [
					{ namespace: "token", value: "new" },
					{ namespace: "token", value: "new" },
				],
			},
		]);
		expect(
			await index.lookupIds([{ namespace: "token", value: "old" }], 10),
		).toEqual([]);
		expect(
			await index.lookupIds([{ namespace: "token", value: "new" }], 10),
		).toEqual(["row"]);

		await index.insert([
			{ id: "row", vector: new Float32Array([1, 0]), metadata: {} },
		]);
		expect(
			await index.lookupIds([{ namespace: "token", value: "new" }], 10),
		).toEqual([]);

		await index.insertKeyed([
			{
				id: "row",
				vector: new Float32Array([1, 0]),
				metadata: {},
				lookupKeys: [{ namespace: "token", value: "delete-me" }],
			},
		]);
		expect(await index.delete(["row"])).toBe(1);
		expect(
			await index.lookupIds([{ namespace: "token", value: "delete-me" }], 10),
		).toEqual([]);
		await index.dispose();
	});

	it("validates and binds lookup inputs without partially replacing records", async () => {
		const database = await openMemoryDatabase();
		const index = new SqliteDatabaseVectorIndex(
			{ name: "lookup-validation", dimension: 2 },
			database,
			false,
		);
		await index.insertKeyed([
			{
				id: "safe",
				vector: new Float32Array([1, 0]),
				metadata: {},
				lookupKeys: [
					{
						namespace: `token') OR 1=1 --`,
						value: `a'); DROP TABLE edgeproc_vectors; --`,
					},
				],
			},
		]);
		expect(
			await index.lookupIds(
				[
					{
						namespace: `token') OR 1=1 --`,
						value: `a'); DROP TABLE edgeproc_vectors; --`,
					},
				],
				1,
			),
		).toEqual(["safe"]);
		database.exec(`
			CREATE TRIGGER reject_lookup_key
			BEFORE INSERT ON edgeproc_vector_lookup_keys
			WHEN NEW.lookup_key = 'force-rollback'
			BEGIN
				SELECT RAISE(ABORT, 'forced lookup failure');
			END;
		`);
		await expect(
			index.insertKeyed([
				{
					id: "safe",
					vector: new Float32Array([0, 1]),
					metadata: {},
					lookupKeys: [{ namespace: "token", value: "replacement" }],
				},
				{
					id: "fails",
					vector: new Float32Array([0, 1]),
					metadata: {},
					lookupKeys: [{ namespace: "token", value: "force-rollback" }],
				},
			]),
		).rejects.toThrow(/forced lookup failure/);
		expect(
			await index.lookupIds(
				[
					{
						namespace: `token') OR 1=1 --`,
						value: `a'); DROP TABLE edgeproc_vectors; --`,
					},
				],
				1,
			),
		).toEqual(["safe"]);
		expect(await index.read("fails")).toBeUndefined();

		await expect(
			index.insertKeyed([
				{
					id: "safe",
					vector: new Float32Array([0, 1]),
					metadata: {},
					lookupKeys: [{ namespace: "", value: "invalid" }],
				},
			]),
		).rejects.toThrow(/empty namespace/);
		expect(
			await index.lookupIds(
				[
					{
						namespace: `token') OR 1=1 --`,
						value: `a'); DROP TABLE edgeproc_vectors; --`,
					},
				],
				1,
			),
		).toEqual(["safe"]);
		await expect(
			index.lookupIds([{ namespace: "", value: "x" }], 1),
		).rejects.toThrow(/empty namespace/);
		await expect(
			index.lookupIds([{ namespace: "x", value: "" }], 1),
		).rejects.toThrow(/empty value/);
		await expect(index.lookupIds([], 0)).rejects.toThrow(/document frequency/);
		await expect(
			index.lookupIds(
				Array.from({ length: 65 }, (_, ordinal) => ({
					namespace: "token",
					value: String(ordinal),
				})),
				1,
			),
		).rejects.toThrow(/at most 64/);
		expect((await index.stats()).vectorCount).toBe(1);
		await index.dispose();
	});

	it("rejects reopening a database with a different dimension", async () => {
		const database = await openMemoryDatabase();
		const first = new SqliteDatabaseVectorIndex(
			{ name: "dimension", dimension: 2 },
			database,
			false,
		);
		expect(
			() =>
				new SqliteDatabaseVectorIndex(
					{ name: "dimension", dimension: 3 },
					database,
					false,
				),
		).toThrow(/has dimension 2; requested 3/);
		await first.dispose();
	});
});

describe("SqliteDatabaseVectorIndex memory profile wiring", () => {
	it("applies the requested profile when the index opens", async () => {
		const database = await openMemoryDatabase();
		new SqliteDatabaseVectorIndex(
			{ name: "profiled", dimension: 2, memoryProfile: "minimal" },
			database,
			false,
		);
		expect(database.selectObjects("PRAGMA cache_size")[0]?.cache_size).toBe(
			-4096,
		);
		expect(
			database.selectObjects("PRAGMA hard_heap_limit")[0]?.hard_heap_limit,
		).toBe(48 * 1024 * 1024);
	});

	it("leaves SQLite defaults when no profile is requested", async () => {
		const baseline = (await openMemoryDatabase()).selectObjects(
			"PRAGMA cache_size",
		)[0]?.cache_size;
		const database = await openMemoryDatabase();
		new SqliteDatabaseVectorIndex(
			{ name: "plain", dimension: 2 },
			database,
			false,
		);
		expect(database.selectObjects("PRAGMA cache_size")[0]?.cache_size).toBe(
			baseline,
		);
	});
});
