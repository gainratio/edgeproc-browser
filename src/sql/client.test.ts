// @vitest-environment node
//
// The round trip through the Worker protocol: every request and response is
// structured-cloned exactly as postMessage would, and the far side is the real
// handler driving the real pinned SQLite build.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import { loadNodeSqlite, type NodeSqlite } from "./__fixtures__/nodeSqlite";
import {
	exportDatabase,
	migrateLegacySahPool,
	openSqlDatabase,
	type SqlWorkerLike,
} from "./client";
import { SqlEngine } from "./engine";
import { createSqlWorkerHandler } from "./handler";
import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol";
import { SqlImportRejectedError, SqlStorageUnavailableError } from "./types";

let sqlite: NodeSqlite;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
});

class InProcessWorker implements SqlWorkerLike {
	readonly requests: SqlWorkerRequest[] = [];
	terminated = false;
	readonly #handle: (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>;
	readonly #listeners = new Map<string, Array<(event: never) => void>>();

	public constructor(
		handle: (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>,
	) {
		this.#handle = handle;
	}

	public postMessage(request: SqlWorkerRequest): void {
		const cloned = structuredClone(request);
		this.requests.push(cloned);
		void this.#handle(cloned).then((response) =>
			this.emit("message", { data: structuredClone(response) }),
		);
	}

	public addEventListener(type: string, listener: (event: never) => void) {
		const list = this.#listeners.get(type) ?? [];
		list.push(listener);
		this.#listeners.set(type, list);
	}

	public emit(type: string, event: unknown): void {
		for (const listener of this.#listeners.get(type) ?? []) {
			(listener as (event: unknown) => void)(event);
		}
	}

	public terminate(): void {
		this.terminated = true;
	}
}

const OPENED = { persistence: "memory", reason: "requested" } as const;

/** Opens fine, then answers every other request with `answer` (or never). */
function scriptedWorker(
	answer: (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>,
): InProcessWorker {
	return new InProcessWorker(async (request) =>
		request.operation === "open"
			? { id: request.id, ok: true, value: OPENED }
			: answer(request),
	);
}

function realWorker(): InProcessWorker {
	return new InProcessWorker(
		createSqlWorkerHandler(async (options) => ({
			engine: new SqlEngine(sqlite.openMemory(), {
				storage: { persistence: "memory", reason: "requested" },
				memoryProfile:
					MEMORY_PROFILES[
						options.memoryProfile === "minimal" ? "minimal" : "lite"
					],
			}),
			release: async () => undefined,
		})),
	);
}

describe("openSqlDatabase through the Worker protocol", () => {
	it("round-trips exec, query, blobs, transactions, executeMany and prepared statements", async () => {
		const worker = realWorker();
		const db = await openSqlDatabase(
			{ name: "roundtrip", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		expect(db.storage).toEqual({ persistence: "memory", reason: "requested" });

		await db.exec(
			"CREATE TABLE items(id INTEGER PRIMARY KEY, title TEXT, embedding BLOB)",
		);
		const loaded = await db.executeMany("INSERT INTO items VALUES (?, ?, ?)", [
			[1, "alpha", new Float32Array([1, 0])],
			[2, "beta", new Float32Array([0, 1])],
		]);
		expect(loaded.changes).toBe(2);
		const rows = await db.query<{ title: string; embedding: Uint8Array }>(
			"SELECT title, embedding FROM items WHERE id = ?",
			[1],
		);
		expect(rows[0]?.title).toBe("alpha");
		expect(
			new Float32Array(rows[0]?.embedding.slice().buffer ?? new ArrayBuffer(0)),
		).toEqual(new Float32Array([1, 0]));

		const tx = await db.transaction([
			{ sql: "UPDATE items SET title = upper(title)" },
			{ sql: "SELECT title FROM items ORDER BY id" },
		]);
		expect(tx).toEqual({
			changes: 2,
			results: [[], [{ title: "ALPHA" }, { title: "BETA" }]],
		});

		const byId = await db.prepare("SELECT title FROM items WHERE id = :id");
		expect(await byId.all({ ":id": 2 })).toEqual([{ title: "BETA" }]);
		const insert = await db.prepare("INSERT INTO items(title) VALUES (?)");
		expect(await insert.run(["gamma"])).toEqual({
			changes: 1,
			lastInsertRowid: 3,
		});
		await insert.finalize();
		await expect(insert.run(["delta"])).rejects.toThrow(/is not open/);

		const info = await db.runtimeInfo();
		expect(info).toMatchObject({ fts5: true, json1: true });
		await db.close();
		expect(worker.terminated).toBe(true);
		await expect(db.query("SELECT 1")).rejects.toThrow(/closed/);
		await db.close();
	});

	it("rejects with the SQLite error message and keeps working", async () => {
		const db = await openSqlDatabase(
			{ name: "errors", persistence: "memory" },
			{ workerFactory: realWorker },
		);
		await expect(db.query("SELECT * FROM missing")).rejects.toThrow(
			/no such table/,
		);
		expect(await db.query("SELECT 1 AS one")).toEqual([{ one: 1 }]);
		await db.close();
	});

	it("re-raises a storage refusal as SqlStorageUnavailableError with its reason", async () => {
		const worker = new InProcessWorker(
			createSqlWorkerHandler(async () => {
				throw new SqlStorageUnavailableError("pool-in-use", "owned elsewhere");
			}),
		);
		const opening = openSqlDatabase(
			{ name: "refused" },
			{ workerFactory: () => worker },
		);
		await expect(opening).rejects.toBeInstanceOf(SqlStorageUnavailableError);
		await expect(opening).rejects.toMatchObject({ reason: "pool-in-use" });
		expect(worker.terminated).toBe(true);
	});

	it("refuses a second open on the same Worker and calls before open", async () => {
		const handle = createSqlWorkerHandler(async () => ({
			engine: new SqlEngine(sqlite.openMemory(), {
				storage: { persistence: "memory", reason: "requested" },
				memoryProfile: MEMORY_PROFILES.lite,
			}),
			release: async () => undefined,
		}));
		expect(
			await handle({ id: 1, operation: "query", sql: "SELECT 1" }),
		).toEqual({
			id: 1,
			ok: false,
			error: {
				name: "Error",
				message: "SQL worker has no open database",
			},
		});
		const options = { name: "twice" };
		expect((await handle({ id: 2, operation: "open", options })).ok).toBe(true);
		expect(await handle({ id: 3, operation: "open", options })).toMatchObject({
			ok: false,
			error: { message: "SQL worker already has an open database" },
		});
	});

	it("fails every pending call when the Worker crashes", async () => {
		const worker = new InProcessWorker(async (request) => {
			if (request.operation === "open") {
				return {
					id: request.id,
					ok: true,
					value: { persistence: "memory", reason: "requested" },
				};
			}
			return new Promise<SqlWorkerResponse>(() => undefined);
		});
		const db = await openSqlDatabase(
			{ name: "crash", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		const pending = db.query("SELECT 1");
		worker.emit("error", { message: "boom" });
		await expect(pending).rejects.toThrow(/SQL worker failed: boom/);
		await expect(db.query("SELECT 1")).rejects.toThrow(/boom/);

		const unreadable = new InProcessWorker(async (request) =>
			request.operation === "open"
				? {
						id: request.id,
						ok: true,
						value: { persistence: "memory", reason: "requested" },
					}
				: new Promise<SqlWorkerResponse>(() => undefined),
		);
		const second = await openSqlDatabase(
			{ name: "garbled", persistence: "memory" },
			{ workerFactory: () => unreadable },
		);
		const waiting = second.exec("SELECT 1");
		unreadable.emit("messageerror", {});
		await expect(waiting).rejects.toThrow(/unreadable message/);
	});

	it("reports both errors when an interactive transaction cannot roll back", async () => {
		const worker = scriptedWorker(async (request) =>
			request.operation === "rollback"
				? {
						id: request.id,
						ok: false,
						error: { name: "Error", message: "disk I/O error" },
					}
				: { id: request.id, ok: true, value: undefined },
		);
		const db = await openSqlDatabase(
			{ name: "stuck", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		const boom = new Error("boom");
		const failure = await db
			.transaction(async () => {
				throw boom;
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors[0]).toBe(boom);
		expect((failure as AggregateError).errors[1]).toMatchObject({
			message: "disk I/O error",
		});
		expect(worker.requests.map((r) => r.operation)).toEqual([
			"open",
			"begin",
			"rollback",
		]);
	});

	it("refuses an interactive transaction on a closed handle without posting", async () => {
		const worker = realWorker();
		const db = await openSqlDatabase(
			{ name: "closed-tx", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		await db.close();
		const posted = worker.requests.length;
		await expect(db.transaction(async () => 1)).rejects.toThrow(/closed/);
		expect(worker.requests.length).toBe(posted);
	});

	it("serializes a non-Error throw from the Worker side", async () => {
		const handle = createSqlWorkerHandler(async () => {
			throw "plain string";
		});
		expect(
			await handle({ id: 7, operation: "open", options: { name: "s" } }),
		).toEqual({
			id: 7,
			ok: false,
			error: { name: "Error", message: "plain string" },
		});
	});

	it("ignores a response for a request it never sent", async () => {
		const worker = realWorker();
		const db = await openSqlDatabase(
			{ name: "stray", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		expect(() =>
			worker.emit("message", { data: { id: 999, ok: true, value: 1 } }),
		).not.toThrow();
		expect(await db.query("SELECT 1 AS one")).toEqual([{ one: 1 }]);
		await db.close();
	});

	it("routes legacy migration to the Worker's migrator, by handle or by name", async () => {
		const seen: unknown[] = [];
		const opened: unknown[] = [];
		const factory = () =>
			new InProcessWorker(
				createSqlWorkerHandler(async (options) => {
					opened.push(options);
					return {
						engine: new SqlEngine(sqlite.openMemory(), {
							storage: { persistence: "memory", reason: "requested" },
							memoryProfile: MEMORY_PROFILES.lite,
						}),
						release: async () => undefined,
						migrateLegacy: async (request) => {
							seen.push(request);
							return { status: "absent" } as const;
						},
					};
				}),
			);
		const request = {
			fromPool: "amlfilter-workstation",
			fromFile: "/kyc.sqlite3",
			removeLegacy: true,
			importOptions: { allowTriggersAndViews: true },
		};
		const db = await openSqlDatabase(
			{ name: "handle", persistence: "memory" },
			{ workerFactory: factory },
		);
		expect(await migrateLegacySahPool({ ...request, to: db })).toEqual({
			status: "absent",
		});
		await db.close();
		expect(
			await migrateLegacySahPool(
				{ ...request, to: "workstation" },
				{ workerFactory: factory },
			),
		).toEqual({ status: "absent" });
		expect(seen).toEqual([request, request]);
		expect(opened[1]).toEqual({
			name: "workstation",
			persistence: "opfs",
			fallback: "none",
		});
	});

	it("posts only the fields a call was given", async () => {
		const worker = scriptedWorker(async (request) => ({
			id: request.id,
			ok: true,
			value: undefined,
		}));
		const db = await openSqlDatabase(
			{ name: "shape", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		await db.exec("SELECT 1");
		await db.importDatabase(new Uint8Array([1]));
		expect(worker.requests.slice(1)).toEqual([
			{ id: 2, operation: "exec", sql: "SELECT 1" },
			{ id: 3, operation: "import", bytes: new Uint8Array([1]) },
		]);
		expect(worker.requests[1]).not.toHaveProperty("bind");
		expect(worker.requests[2]).not.toHaveProperty("options");
	});

	it("fails calls still in flight at close with 'SQL database is closed'", async () => {
		const worker = scriptedWorker((request) =>
			request.operation === "close"
				? Promise.resolve({ id: request.id, ok: true, value: undefined })
				: new Promise<SqlWorkerResponse>(() => undefined),
		);
		const db = await openSqlDatabase(
			{ name: "inflight", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		const pending = db.query("SELECT 1");
		await db.close();
		await expect(pending).rejects.toThrow("SQL database is closed");
	});

	it("refuses a call made while close is in flight, without posting it", async () => {
		const worker = realWorker();
		const db = await openSqlDatabase(
			{ name: "closing", persistence: "memory" },
			{ workerFactory: () => worker },
		);
		const closing = db.close();
		const late = db.query("SELECT 1");
		await expect(late).rejects.toThrow("SQL database is closed");
		await closing;
		expect(worker.requests.map((request) => request.operation)).toEqual([
			"open",
			"close",
		]);
	});

	it("opens a database by name on OPFS with no memory fallback, then closes it", async () => {
		const worker = scriptedWorker(async (request) => ({
			id: request.id,
			ok: true,
			value: request.operation === "export" ? new Uint8Array([7]) : undefined,
		}));
		const bytes = await exportDatabase("by-name", {
			workerFactory: () => worker,
		});
		expect(bytes).toEqual(new Uint8Array([7]));
		expect(worker.requests[0]).toMatchObject({
			operation: "open",
			options: { name: "by-name", persistence: "opfs", fallback: "none" },
		});
		expect(worker.requests.at(-1)?.operation).toBe("close");
		expect(worker.terminated).toBe(true);
	});

	it.each([
		[
			"an import rejection with its reason",
			{ name: "SqlImportRejectedError", message: "m", rejection: "corrupt" },
			SqlImportRejectedError,
			{ reason: "corrupt" },
		],
		[
			"a storage refusal with its reason",
			{
				name: "SqlStorageUnavailableError",
				message: "m",
				reason: "opfs-unavailable",
			},
			SqlStorageUnavailableError,
			{ reason: "opfs-unavailable" },
		],
	] as const)(
		"rebuilds %s as its typed error",
		async (_label, error, type, fields) => {
			const db = await openSqlDatabase(
				{ name: "typed", persistence: "memory" },
				{
					workerFactory: () =>
						scriptedWorker(async (request) => ({
							id: request.id,
							ok: false,
							error,
						})),
				},
			);
			const failing = db.query("SELECT 1");
			await expect(failing).rejects.toBeInstanceOf(type);
			await expect(failing).rejects.toMatchObject({ ...fields, message: "m" });
		},
	);

	it.each([
		[
			"a reason on a plain Error",
			{ name: "Error", message: "m", reason: "pool-in-use" },
		],
		[
			"a rejection on a plain Error",
			{ name: "Error", message: "m", rejection: "corrupt" },
		],
		[
			"SqlImportRejectedError without a rejection",
			{ name: "SqlImportRejectedError", message: "m" },
		],
		[
			"SqlStorageUnavailableError without a reason",
			{ name: "SqlStorageUnavailableError", message: "m" },
		],
	] as const)(
		"does not trust %s: it stays a plain named Error",
		async (_label, error) => {
			const db = await openSqlDatabase(
				{ name: "untyped", persistence: "memory" },
				{
					workerFactory: () =>
						scriptedWorker(async (request) => ({
							id: request.id,
							ok: false,
							error,
						})),
				},
			);
			const failure = await db
				.query("SELECT 1")
				.catch((caught: unknown) => caught);
			expect(failure).not.toBeInstanceOf(SqlImportRejectedError);
			expect(failure).not.toBeInstanceOf(SqlStorageUnavailableError);
			expect(failure).toMatchObject({ name: error.name, message: "m" });
		},
	);

	it("answers close only after the lease's release has settled", async () => {
		const order: string[] = [];
		let settle: () => void = () => undefined;
		const release = () =>
			new Promise<void>((resolve) => {
				settle = () => {
					order.push("released");
					resolve();
				};
			});
		const engine = new SqlEngine(sqlite.openMemory(), {
			storage: { persistence: "memory", reason: "requested" },
			memoryProfile: MEMORY_PROFILES.lite,
		});
		const handle = createSqlWorkerHandler(async () => ({ engine, release }));
		await handle({ id: 1, operation: "open", options: { name: "c" } });
		const closing = handle({ id: 2, operation: "close" }).then((response) => {
			order.push("answered");
			return response;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		settle();
		expect(await closing).toMatchObject({ ok: true });
		expect(order).toEqual(["released", "answered"]);
	});

	it("closes the engine and releases the lease on close, even if close throws", async () => {
		const release = vi.fn();
		const engine = new SqlEngine(sqlite.openMemory(), {
			storage: { persistence: "memory", reason: "requested" },
			memoryProfile: MEMORY_PROFILES.lite,
		});
		const closeEngine = vi.spyOn(engine, "close").mockImplementation(() => {
			throw new Error("close failed");
		});
		const handle = createSqlWorkerHandler(async () => ({ engine, release }));
		await handle({ id: 1, operation: "open", options: { name: "c" } });
		expect(await handle({ id: 2, operation: "close" })).toMatchObject({
			ok: false,
			error: { message: "close failed" },
		});
		expect(closeEngine).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledTimes(1);
		expect(
			await handle({ id: 3, operation: "query", sql: "SELECT 1" }),
		).toMatchObject({
			ok: false,
			error: { message: "SQL worker has no open database" },
		});
	});
});

describe("the default Worker factory", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("starts the library's module Worker, named edgeproc-sql", async () => {
		const created: Array<{ url: URL; options: WorkerOptions }> = [];
		vi.stubGlobal(
			"Worker",
			class extends InProcessWorker {
				public constructor(url: URL, options: WorkerOptions) {
					super(async (request) => ({
						id: request.id,
						ok: true,
						value: request.operation === "open" ? OPENED : undefined,
					}));
					created.push({ url, options });
				}
			},
		);
		const db = await openSqlDatabase({
			name: "default",
			persistence: "memory",
		});
		expect(db.storage).toEqual(OPENED);
		expect(created).toHaveLength(1);
		expect(created[0]?.url.href).toMatch(/\/sql\/worker\.js$/);
		expect(created[0]?.options).toEqual({
			type: "module",
			name: "edgeproc-sql",
		});
		await db.close();
	});
});
