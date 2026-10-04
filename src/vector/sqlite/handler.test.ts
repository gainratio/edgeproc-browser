import { describe, expect, it, vi } from "vitest";
import { SqlStorageUnavailableError } from "../../sql/types";
import { createVectorWorkerHandler, type VectorWorkerIndex } from "./handler";

function fakeIndex(): VectorWorkerIndex {
	return {
		capabilities: Object.freeze({
			metrics: Object.freeze(["cosine"] as const),
			exact: true,
			persistent: true,
			metadataFiltering: true,
			scopedDelete: true,
		}),
		insert: vi.fn(async () => undefined),
		insertKeyed: vi.fn(async () => undefined),
		read: vi.fn(async () => undefined),
		search: vi.fn(async () => []),
		searchByIds: vi.fn(async () => []),
		lookupIds: vi.fn(async () => ["id"]),
		delete: vi.fn(async () => 1),
		deleteWhere: vi.fn(async () => 2),
		clear: vi.fn(async () => 3),
		stats: vi.fn(async () => ({
			name: "n",
			dimension: 2,
			vectorCount: 0,
			vectorBytes: 0,
		})),
		runtimeInfo: vi.fn(() => ({
			sqliteVersion: "3.53.4",
			vectorVersion: "1.1.2",
			vectorBackend: "CPU",
			bundledExtensions: ["vector_version"],
		})),
		dispose: vi.fn(async () => undefined),
	} as unknown as VectorWorkerIndex;
}

const options = { name: "n", dimension: 2 } as const;

describe("createVectorWorkerHandler", () => {
	it("answers dispose only after the pool's release has settled", async () => {
		const order: string[] = [];
		let settle: () => void = () => undefined;
		const release = () =>
			new Promise<void>((resolve) => {
				settle = () => {
					order.push("released");
					resolve();
				};
			});
		const index = fakeIndex();
		const handle = createVectorWorkerHandler(async () => ({ index, release }));
		await handle({ id: 1, operation: "initialize", options });
		const disposing = handle({ id: 2, operation: "dispose" }).then((r) => {
			order.push("answered");
			return r;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual([]);
		settle();
		expect(await disposing).toEqual({ id: 2, ok: true, value: undefined });
		expect(order).toEqual(["released", "answered"]);
		expect(index.dispose).toHaveBeenCalledTimes(1);
	});

	it("routes every query operation to the open index", async () => {
		const index = fakeIndex();
		const handle = createVectorWorkerHandler(async () => ({
			index,
			release: async () => undefined,
		}));
		const init = await handle({ id: 1, operation: "initialize", options });
		expect(init).toMatchObject({ ok: true, value: index.capabilities });
		const q = new Float32Array([1, 0]);
		const results = await Promise.all([
			handle({ id: 2, operation: "insert", records: [] }),
			handle({ id: 3, operation: "insert-keyed", records: [] }),
			handle({ id: 4, operation: "read", recordId: "a" }),
			handle({ id: 5, operation: "search", query: q, limit: 1 }),
			handle({ id: 6, operation: "search-by-ids", query: q, ids: [] }),
			handle({
				id: 7,
				operation: "lookup-ids",
				keys: [],
				maxDocumentFrequency: 1,
			}),
			handle({ id: 8, operation: "delete", ids: ["a"] }),
			handle({ id: 9, operation: "delete-where", filters: { a: "b" } }),
			handle({ id: 10, operation: "clear" }),
			handle({ id: 11, operation: "stats" }),
			handle({ id: 12, operation: "runtime-info" }),
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.map((r) => (r.ok ? r.value : r.error)).slice(5, 9)).toEqual([
			["id"],
			1,
			2,
			3,
		]);
		expect(index.search).toHaveBeenCalledWith(q, 1, undefined);
	});

	it("refuses a second initialize and calls before initialize", async () => {
		const handle = createVectorWorkerHandler(async () => ({
			index: fakeIndex(),
			release: async () => undefined,
		}));
		expect(await handle({ id: 1, operation: "clear" })).toMatchObject({
			ok: false,
			error: { message: "SQLite vector worker is not initialized" },
		});
		await handle({ id: 2, operation: "initialize", options });
		expect(
			await handle({ id: 3, operation: "initialize", options }),
		).toMatchObject({
			ok: false,
			error: { message: "SQLite vector worker is already initialized" },
		});
	});

	it("serializes a typed pool-in-use refusal with its reason", async () => {
		const handle = createVectorWorkerHandler(async () => {
			throw new SqlStorageUnavailableError("pool-in-use", "taken");
		});
		expect(await handle({ id: 1, operation: "initialize", options })).toEqual({
			id: 1,
			ok: false,
			error: {
				name: "SqlStorageUnavailableError",
				message: "taken",
				reason: "pool-in-use",
			},
		});
		const plain = createVectorWorkerHandler(async () => {
			throw "not an error";
		});
		expect(
			await plain({ id: 2, operation: "initialize", options }),
		).toMatchObject({ error: { name: "Error", message: "not an error" } });
	});
});
