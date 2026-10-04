import { describe, expect, it } from "vitest";
import { SqlStorageUnavailableError } from "../../sql/types";
import { SqliteVectorIndexClient } from "./client";
import type {
	SqliteVectorWorkerRequest,
	SqliteVectorWorkerResponse,
} from "./protocol";

class FakeWorker {
	readonly requests: SqliteVectorWorkerRequest[] = [];
	terminated = false;
	readonly refusal:
		| { readonly name: string; readonly message: string }
		| undefined;
	readonly #messageListeners: Array<
		(event: MessageEvent<SqliteVectorWorkerResponse>) => void
	> = [];
	readonly #errorListeners: Array<(event: ErrorEvent) => void> = [];
	readonly #messageErrorListeners: Array<
		(event: MessageEvent<unknown>) => void
	> = [];

	constructor(refusal?: { readonly name: string; readonly message: string }) {
		this.refusal = refusal;
	}

	postMessage(request: SqliteVectorWorkerRequest): void {
		this.requests.push(request);
		queueMicrotask(() => {
			if (this.refusal === undefined) {
				this.respond(request.id, valueFor(request));
			} else {
				this.respondFailure(request.id, this.refusal);
			}
		});
	}

	terminate(): void {
		this.terminated = true;
	}

	addEventListener(
		type: "message" | "error" | "messageerror",
		listener:
			| ((event: MessageEvent<SqliteVectorWorkerResponse>) => void)
			| ((event: ErrorEvent) => void)
			| ((event: MessageEvent<unknown>) => void),
	): void {
		if (type === "message") {
			this.#messageListeners.push(
				listener as (event: MessageEvent<SqliteVectorWorkerResponse>) => void,
			);
		} else if (type === "error") {
			this.#errorListeners.push(listener as (event: ErrorEvent) => void);
		} else {
			this.#messageErrorListeners.push(
				listener as (event: MessageEvent<unknown>) => void,
			);
		}
	}

	fail(message: string): void {
		const event = new ErrorEvent("error", { message });
		for (const listener of this.#errorListeners) {
			listener(event);
		}
	}

	failMessage(): void {
		const event = new MessageEvent("messageerror");
		for (const listener of this.#messageErrorListeners) {
			listener(event);
		}
	}

	private respond(id: number, value: unknown): void {
		const event = new MessageEvent<SqliteVectorWorkerResponse>("message", {
			data: { id, ok: true, value },
		});
		for (const listener of this.#messageListeners) {
			listener(event);
		}
	}

	private respondFailure(
		id: number,
		error: { readonly name: string; readonly message: string },
	): void {
		const event = new MessageEvent<SqliteVectorWorkerResponse>("message", {
			data: { id, ok: false, error },
		});
		for (const listener of this.#messageListeners) {
			listener(event);
		}
	}
}

function valueFor(request: SqliteVectorWorkerRequest): unknown {
	switch (request.operation) {
		case "read":
			return {
				id: request.recordId,
				vector: new Float32Array([1, 0]),
				metadata: {},
			};
		case "search":
			return [{ id: "nearest", distance: 0, metadata: {} }];
		case "search-by-ids":
			return [{ id: request.ids[0] ?? "missing", distance: 0, metadata: {} }];
		case "lookup-ids":
			return ["lookup-row"];
		case "delete":
			return request.ids.length;
		case "delete-where":
			return 2;
		case "clear":
			return 3;
		case "stats":
			return {
				name: "client",
				dimension: 2,
				vectorCount: 1,
				vectorBytes: 8,
			};
		case "runtime-info":
			return {
				sqliteVersion: "3.53.4",
				vectorVersion: "1.1.2",
				vectorBackend: "CPU",
				bundledExtensions: ["vector_version"],
			};
		default:
			return undefined;
	}
}

describe("SqliteVectorIndexClient", () => {
	it("rebuilds a typed pool-in-use refusal from the Worker", async () => {
		const worker = new FakeWorker({
			name: "SqlStorageUnavailableError",
			message: "another tab owns it",
			reason: "pool-in-use",
		} as { name: string; message: string });
		const index = new SqliteVectorIndexClient(
			{ name: "taken", dimension: 2 },
			() => worker,
		);
		const opening = index.ready();
		await expect(opening).rejects.toBeInstanceOf(SqlStorageUnavailableError);
		await expect(opening).rejects.toMatchObject({
			reason: "pool-in-use",
			message: "another tab owns it",
		});
	});

	it("proxies the typed index API and terminates on disposal", async () => {
		const worker = new FakeWorker();
		const index = new SqliteVectorIndexClient(
			{ name: "client", dimension: 2, persistence: "memory" },
			() => worker,
		);
		await index.ready();

		await index.insert([
			{ id: "row", vector: new Float32Array([1, 0]), metadata: {} },
		]);
		await index.insertKeyed([
			{
				id: "lookup-row",
				vector: new Float32Array([1, 0]),
				metadata: {},
				lookupKeys: [{ namespace: "token", value: "lookup" }],
			},
		]);
		expect((await index.read("row"))?.id).toBe("row");
		expect((await index.search(new Float32Array([1, 0]), 1))[0]?.id).toBe(
			"nearest",
		);
		expect(
			(await index.searchByIds(new Float32Array([1, 0]), ["row"]))[0]?.id,
		).toBe("row");
		expect(
			await index.lookupIds([{ namespace: "token", value: "lookup" }], 10),
		).toEqual(["lookup-row"]);
		expect(await index.delete(["row"])).toBe(1);
		expect(await index.deleteWhere({ tenant: "client" })).toBe(2);
		expect(await index.clear()).toBe(3);
		expect((await index.stats()).vectorBytes).toBe(8);
		expect((await index.runtimeInfo()).vectorVersion).toBe("1.1.2");
		expect(worker.requests).toContainEqual({
			id: expect.any(Number),
			operation: "insert-keyed",
			records: [
				{
					id: "lookup-row",
					vector: new Float32Array([1, 0]),
					metadata: {},
					lookupKeys: [{ namespace: "token", value: "lookup" }],
				},
			],
		});
		expect(worker.requests).toContainEqual({
			id: expect.any(Number),
			operation: "lookup-ids",
			keys: [{ namespace: "token", value: "lookup" }],
			maxDocumentFrequency: 10,
		});

		await index.dispose();
		await index.dispose();
		expect(worker.terminated).toBe(true);
		await expect(index.stats()).rejects.toThrow(/disposed/);
	});

	it("makes a Worker crash terminal for current and future calls", async () => {
		const worker = new FakeWorker();
		const index = new SqliteVectorIndexClient(
			{ name: "crash", dimension: 2 },
			() => worker,
		);
		await index.ready();
		worker.fail("boom");

		const requestCount = worker.requests.length;
		await expect(index.stats()).rejects.toThrow(/worker failed: boom/);
		expect(worker.requests).toHaveLength(requestCount);
		expect(worker.terminated).toBe(true);
	});

	it("fails closed when a Worker message cannot be cloned", async () => {
		const worker = new FakeWorker();
		const index = new SqliteVectorIndexClient(
			{ name: "message", dimension: 2 },
			() => worker,
		);
		await index.ready();
		worker.failMessage();

		await expect(index.read("row")).rejects.toThrow(/unreadable message/);
		expect(worker.terminated).toBe(true);
	});

	it("terminates the Worker when initialization is refused", async () => {
		const worker = new FakeWorker({
			name: "SecurityError",
			message: "OPFS unavailable",
		});
		const index = new SqliteVectorIndexClient(
			{ name: "refused", dimension: 2 },
			() => worker,
		);

		await expect(index.ready()).rejects.toThrow(/OPFS unavailable/);
		expect(worker.terminated).toBe(true);
		await expect(index.stats()).rejects.toThrow(/OPFS unavailable/);
	});
});
