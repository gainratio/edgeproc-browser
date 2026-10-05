// @vitest-environment node
// cacheFallback: "none" — when the browser refuses OPFS, the engine must not
// open an in-memory cache and must not download the bundle into RAM. It fails
// fast with a typed EngineStorageUnavailableError the app can recognise.
//
// This drives the REAL Worker entry module (src/engine/worker.ts) through the
// REAL EngineClient over an in-process loopback. Only the browser edges are
// faked: the SQLite runtime (OPFS refused, openMemory counted), fetchBytes
// (every byte counted), and the Worker global.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineRequest, EngineResponse } from "./protocol.js";

const counters = vi.hoisted(() => ({
	fetches: 0,
	memoryOpens: 0,
	poolInstalls: 0,
}));

vi.mock("../sql/workerRuntime.js", () => ({
	loadSqlite: async () => ({}),
	workerStorageDeps: () => ({
		openMemory: () => {
			counters.memoryOpens += 1;
			throw new Error("in-memory cache opened");
		},
		installPool: async () => {
			counters.poolInstalls += 1;
			throw new DOMException("refused by the test", "UnknownError");
		},
		locks: undefined,
		warn: () => undefined,
		lockWaitMs: 0,
	}),
}));

vi.mock("./networkSentinel.js", () => ({
	installNetworkSentinel: () => () => undefined,
}));

vi.mock("./fetchBytes.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./fetchBytes.js")>()),
	fetchBytes: async () => {
		counters.fetches += 1;
		throw new Error("network reached");
	},
}));

type Listener = (event: { data: unknown }) => void;

/** Wire an EngineClient to the Worker module in this realm. */
async function loopbackClient() {
	const toWorker: Listener[] = [];
	const toClient: Listener[] = [];
	vi.stubGlobal("self", {
		addEventListener: (_type: string, listener: Listener) => {
			toWorker.push(listener);
		},
		postMessage: (message: EngineResponse) => {
			queueMicrotask(() => {
				for (const listener of toClient) listener({ data: message });
			});
		},
	});
	vi.stubGlobal("navigator", {
		storage: {
			getDirectory: () => Promise.reject(new DOMException("refused")),
		},
	});
	await import("./worker.js");
	const { EngineClient } = await import("./client.js");
	return new EngineClient({
		postMessage: (request: EngineRequest) => {
			queueMicrotask(() => {
				for (const listener of toWorker) listener({ data: request });
			});
		},
		addEventListener: (type: string, listener: Listener) => {
			if (type === "message") toClient.push(listener);
		},
		terminate: () => undefined,
	} as never);
}

beforeEach(() => {
	vi.resetModules();
	counters.fetches = 0;
	counters.memoryOpens = 0;
	counters.poolInstalls = 0;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('cacheFallback: "none" with OPFS refused', () => {
	it("rejects with EngineStorageUnavailableError and fetches nothing", async () => {
		const client = await loopbackClient();
		const { EngineStorageUnavailableError, EngineOperationError } =
			await import("./engineError.js");

		const failure = await client
			.sync("https://bundle.example/", "https://bundle.example/key", {
				cacheFallback: "none",
			})
			.then(
				() => null,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(EngineStorageUnavailableError);
		expect(failure).toBeInstanceOf(EngineOperationError);
		expect(failure).toMatchObject({
			name: "EngineStorageUnavailableError",
			code: "storage",
			reason: "opfs-unavailable",
		});
		expect(counters.poolInstalls).toBe(1);
		expect(counters.memoryOpens).toBe(0);
		expect(counters.fetches).toBe(0);
		client.dispose();
	});

	it("clear() honours it too: no in-memory cache is opened", async () => {
		const client = await loopbackClient();
		const { EngineStorageUnavailableError } = await import("./engineError.js");

		await expect(
			client.clear({ cacheFallback: "none" }),
		).rejects.toBeInstanceOf(EngineStorageUnavailableError);
		expect(counters.memoryOpens).toBe(0);
		client.dispose();
	});

	it("readFile honours it on a fresh Worker, so a later sync is still typed", async () => {
		const client = await loopbackClient();
		const { EngineStorageUnavailableError } = await import("./engineError.js");

		await expect(
			client.readFile("catalog_meta.json", { cacheFallback: "none" }),
		).rejects.toBeInstanceOf(EngineStorageUnavailableError);
		await expect(
			client.sync("https://bundle.example/", "https://bundle.example/key", {
				cacheFallback: "none",
			}),
		).rejects.toBeInstanceOf(EngineStorageUnavailableError);
		expect(counters.memoryOpens).toBe(0);
		expect(counters.fetches).toBe(0);
		client.dispose();
	});

	it("the default stays the in-memory fallback (backward compatible)", async () => {
		const client = await loopbackClient();

		await expect(
			client.sync("https://bundle.example/", "https://bundle.example/key"),
		).rejects.toThrow("in-memory cache opened");
		expect(counters.memoryOpens).toBe(1);
		client.dispose();
	});

	it("a worker refuses to change cacheFallback after first use", async () => {
		const client = await loopbackClient();
		await client
			.sync("https://bundle.example/", "https://bundle.example/key")
			.catch(() => undefined);

		await expect(
			client.sync("https://bundle.example/", "https://bundle.example/key", {
				cacheFallback: "none",
			}),
		).rejects.toThrow("cannot change after first use");
		client.dispose();
	});
});
