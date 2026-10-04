// @vitest-environment node
//
// The round trip through the Worker protocol: every request and response is
// structured-cloned exactly as postMessage would, and the far side is the real
// handler driving the real pinned SQLite build.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import { loadNodeSqlite, type NodeSqlite } from "./__fixtures__/nodeSqlite";
import { openSqlDatabase, type SqlWorkerLike } from "./client";
import { SqlEngine } from "./engine";
import { createSqlWorkerHandler } from "./handler";
import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol";
import { SqlStorageUnavailableError } from "./types";

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
			release: () => undefined,
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
			release: () => undefined,
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
});
