// @vitest-environment node
//
// exportDatabase / importDatabase through the Worker protocol (structured
// clone both ways), with the REAL owner-lock path of openSqlStorage: a fake
// Web Locks manager and a "pool" whose files outlive each connection.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import { FakeLocks } from "./__fixtures__/fakeLocks";
import { loadNodeSqlite, type NodeSqlite } from "./__fixtures__/nodeSqlite";
import {
	exportDatabase,
	importDatabase,
	openSqlDatabase,
	type SqlWorkerLike,
} from "./client";
import { SqlEngine, type SqlRawDatabase } from "./engine";
import { createSqlWorkerHandler } from "./handler";
import { openSqlStorage, sqlDatabasePoolName } from "./open";
import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol";
import { SqlImportRejectedError, SqlStorageUnavailableError } from "./types";

let sqlite: NodeSqlite;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
});

class InProcessWorker implements SqlWorkerLike {
	readonly #handle: (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>;
	readonly #listeners: Array<(event: never) => void> = [];
	readonly #before: (request: SqlWorkerRequest) => Promise<void>;

	public constructor(
		handle: (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>,
		before: (request: SqlWorkerRequest) => Promise<void>,
	) {
		this.#handle = handle;
		this.#before = before;
	}

	public postMessage(request: SqlWorkerRequest): void {
		const cloned = structuredClone(request);
		void this.#before(cloned)
			.then(() => this.#handle(cloned))
			.then((response) => {
				for (const listener of this.#listeners) {
					(listener as (event: unknown) => void)({
						data: structuredClone(response),
					});
				}
			});
	}

	public addEventListener(type: string, listener: (event: never) => void) {
		if (type === "message") this.#listeners.push(listener);
	}

	public terminate(): void {}
}

/** An origin: one lock manager, and pool files that survive close(). */
function origin(lockWaitMs = 5_000) {
	const locks = new FakeLocks();
	// While held, "import" requests wait in the Worker (the lock stays held).
	let gate: Promise<void> = Promise.resolve();
	const holdImports = () => {
		let release: () => void = () => undefined;
		gate = new Promise((resolve) => {
			release = resolve;
		});
		return release;
	};
	const files = new Map<string, SqlRawDatabase>();
	const persistent = (file: string): SqlRawDatabase => {
		const db = files.get(file) ?? sqlite.openMemory();
		files.set(file, db);
		return {
			...(db.pointer === undefined ? {} : { pointer: db.pointer }),
			exec: (options) => db.exec(options),
			selectObjects: (sql, bind) => db.selectObjects(sql, bind),
			prepare: (sql) => db.prepare(sql),
			transaction: (qualifier, callback) => db.transaction(qualifier, callback),
			close: () => undefined,
		};
	};
	const workerFactory = () =>
		new InProcessWorker(
			createSqlWorkerHandler(async (options) => {
				const opened = await openSqlStorage<SqlRawDatabase>(
					{
						openMemory: () => sqlite.openMemory(),
						installPool: async () => ({
							OpfsSAHPoolDb: function PoolDb(file: string) {
								return persistent(file);
							} as unknown as new (
								file: string,
							) => SqlRawDatabase,
						}),
						locks,
						warn: () => undefined,
						lockWaitMs,
					},
					options,
				);
				return {
					// Node has no OPFS: the engine runs the pool file as memory.
					engine: new SqlEngine(opened.raw, {
						storage: { persistence: "memory", reason: "requested" },
						memoryProfile: MEMORY_PROFILES.lite,
						serializer: sqlite.serializer,
					}),
					release: opened.release,
				};
			}),
			(request) => (request.operation === "import" ? gate : Promise.resolve()),
		);
	return { workerFactory, locks, holdImports };
}

async function backup(): Promise<Uint8Array> {
	const { workerFactory } = origin();
	const db = await openSqlDatabase({ name: "source" }, { workerFactory });
	await db.exec(`
		PRAGMA application_id = 7;
		CREATE TABLE charts(id INTEGER PRIMARY KEY, label TEXT, data BLOB);
	`);
	await db.executeMany("INSERT INTO charts VALUES (?, ?, ?)", [
		[1, "me", new Uint8Array([1, 2, 3])],
		[2, "you", null],
	]);
	const bytes = await exportDatabase(db);
	await db.close();
	return bytes;
}

describe("exportDatabase / importDatabase through the Worker", () => {
	it("round-trips by handle and by name, row for row", async () => {
		const bytes = await backup();
		const { workerFactory } = origin();

		const result = await importDatabase("target", bytes, {
			expectedSchema: { applicationId: 7 },
			workerFactory,
		});
		expect(result).toMatchObject({
			applicationId: 7,
			byteLength: bytes.byteLength,
		});

		const db = await openSqlDatabase({ name: "target" }, { workerFactory });
		expect(await db.query("SELECT * FROM charts ORDER BY id")).toEqual([
			{ id: 1, label: "me", data: new Uint8Array([1, 2, 3]) },
			{ id: 2, label: "you", data: null },
		]);
		const again = await db.exportDatabase();
		await db.importDatabase(again);
		const rows = await db.query("SELECT * FROM charts ORDER BY id");
		await db.close();
		// By name: opened under the owner lock, exported, closed.
		const byName = await exportDatabase("target", { workerFactory });
		const check = await openSqlDatabase(
			{ name: "check", persistence: "memory" },
			{ workerFactory },
		);
		await check.importDatabase(byName);
		expect(await check.query("SELECT * FROM charts ORDER BY id")).toEqual(rows);
		await check.close();
	});

	it("carries the typed rejection across the Worker boundary", async () => {
		const bytes = await backup();
		const { workerFactory } = origin();
		const db = await openSqlDatabase({ name: "t" }, { workerFactory });
		const error = await db
			.importDatabase(bytes, { expectedSchema: { applicationId: 8 } })
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SqlImportRejectedError);
		expect((error as SqlImportRejectedError).reason).toBe(
			"foreign-application",
		);
		await db.close();
	});

	it("an import by name fails closed while another context owns the database", async () => {
		const bytes = await backup();
		const { workerFactory } = origin(30);
		const holder = await openSqlDatabase({ name: "busy" }, { workerFactory });
		await holder.exec("CREATE TABLE mine(x); INSERT INTO mine VALUES (1)");

		const error = await importDatabase("busy", bytes, { workerFactory }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(SqlStorageUnavailableError);
		expect((error as SqlStorageUnavailableError).reason).toBe("pool-in-use");
		expect(await holder.query("SELECT x FROM mine")).toEqual([{ x: 1 }]);
		await holder.close();
	});

	it("a writer in another context waits for an import by name to finish", async () => {
		const bytes = await backup();
		const { workerFactory, locks, holdImports } = origin();
		const events: string[] = [];
		const owner = `${await sqlDatabasePoolName("shared")}-owner`;
		const releaseImport = holdImports();

		const importing = importDatabase("shared", bytes, { workerFactory }).then(
			() => events.push("import done"),
		);
		while (!locks.isHeld(owner)) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		events.push("import holds lock");
		const writer = openSqlDatabase({ name: "shared" }, { workerFactory }).then(
			async (db) => {
				events.push("writer opened");
				await db.exec("INSERT INTO charts(label) VALUES ('after import')");
				return db;
			},
		);
		// Give the writer every chance to get in while the import is mid-flight.
		await new Promise((resolve) => setTimeout(resolve, 50));
		events.push("import released");
		releaseImport();
		await importing;
		const db = await writer;

		expect(events).toEqual([
			"import holds lock",
			"import released",
			"import done",
			"writer opened",
		]);
		// The write landed ON the imported data; the import did not wipe it.
		expect(await db.query("SELECT label FROM charts ORDER BY id")).toEqual([
			{ label: "me" },
			{ label: "you" },
			{ label: "after import" },
		]);
		await db.close();
	});
});
