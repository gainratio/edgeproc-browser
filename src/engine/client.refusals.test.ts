// Every FAILURE path of the main-thread Worker client.
//
// The whole reason this class exists is that a Worker which dies during init
// never posts a reply. Without typed failures the caller's promise hangs
// forever — no error, no timeout, no boot. Those are the branches below, and
// they are the ones a happy-path suite cannot reach: crash, latched crash,
// deadline, dispose, and a reply that arrives for a request nobody is awaiting.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EngineClient, type EngineWorkerLike } from "./client.js";
import { EngineOperationError } from "./engineError.js";
import type { EngineRequest, EngineResponse } from "./protocol.js";
import {
	DEFAULT_REQUEST_TIMEOUT_MS,
	WorkerCrashError,
	WorkerTimeoutError,
} from "./workerFault.js";

/** A Worker stand-in whose events this test drives by hand. */
function fakeWorker() {
	const listeners = {
		message: [] as ((event: MessageEvent<EngineResponse>) => void)[],
		error: [] as ((event: { message: string }) => void)[],
		messageerror: [] as (() => void)[],
	};
	const sent: EngineRequest[] = [];
	const terminate = vi.fn();
	const worker: EngineWorkerLike = {
		postMessage: (message) => {
			sent.push(message);
		},
		// biome-ignore lint/suspicious/noExplicitAny: the overloaded listener map
		addEventListener: (type: any, listener: any) => {
			listeners[type as keyof typeof listeners].push(listener);
		},
		terminate,
	};
	return {
		worker,
		sent,
		terminate,
		reply: (response: EngineResponse) => {
			for (const l of listeners.message) {
				l({ data: response } as MessageEvent<EngineResponse>);
			}
		},
		crash: (message: string) => {
			for (const l of listeners.error) l({ message });
		},
		messageerror: () => {
			for (const l of listeners.messageerror) l();
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a Worker that dies never leaves a caller hanging", () => {
	it("rejects and releases when postMessage throws synchronously", async () => {
		const fake = fakeWorker();
		fake.worker.postMessage = () => {
			throw new DOMException("could not clone request", "DataCloneError");
		};
		const client = new EngineClient(fake.worker);

		await expect(client.readFile("catalog_meta.json")).rejects.toBeInstanceOf(
			WorkerCrashError,
		);
		expect(fake.terminate).toHaveBeenCalledOnce();
	});

	it("rejects the in-flight request with WorkerCrashError on 'error'", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.sync("https://cdn.example", "/public.key");
		fake.crash("script load failed");
		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WorkerCrashError);
		expect((error as Error).message).toContain("script load failed");
	});

	it("rejects on 'messageerror' too — an undeserializable reply is a crash", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.readFile("catalog_meta.json");
		fake.messageerror();
		await expect(pending).rejects.toBeInstanceOf(WorkerCrashError);
	});

	it("LATCHES: once crashed, later requests fail fast instead of hanging", async () => {
		// A dead Worker never revives. Sending to it would produce exactly the
		// forever-pending promise this class exists to prevent.
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		fake.crash("boom");
		await expect(client.readFile("a")).rejects.toBeInstanceOf(WorkerCrashError);
		await expect(
			client.sync("https://cdn.example", "/public.key"),
		).rejects.toBeInstanceOf(WorkerCrashError);
		// Nothing was ever posted to the dead worker.
		expect(fake.sent).toHaveLength(0);
	});

	it("keeps the FIRST crash reason — later noise does not overwrite it", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		fake.crash("the real cause");
		fake.crash("a later, less useful message");
		const error = await client.readFile("a").catch((e: unknown) => e);
		expect((error as Error).message).toContain("the real cause");
	});

	// EVERY caller, not just the one that happened to be first in the map — and
	// the Worker itself is released. An 'error' event is an uncaught throw
	// INSIDE the Worker, not proof the Worker died: left alone it keeps running,
	// still holding its OPFS sync access handle, and nothing will ever ask it
	// for anything again. Rejecting the promises without terminating swaps a
	// hung caller for a leaked thread.
	it("rejects EVERY pending call and releases the Worker on a crash", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const first = client.readFile("a");
		const second = client.sync("https://cdn.example", "/public.key");

		fake.crash("fatal boot");

		await expect(first).rejects.toThrow("fatal boot");
		await expect(second).rejects.toThrow("fatal boot");
		expect(fake.terminate).toHaveBeenCalledOnce();
	});
});

describe("a Worker that goes silent is bounded by a deadline", () => {
	it("rejects with WorkerTimeoutError once the deadline passes", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker, { requestTimeoutMs: 50 });
		const pending = client.readFile("catalog_meta.json");
		const assertion =
			expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError);
		await vi.advanceTimersByTimeAsync(51);
		await assertion;
	});

	it("defaults to a 60s response deadline", () => {
		// Pinned to the literal the docs promise, not to the constant itself.
		expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(60_000);
	});

	// A deadline that only settles the CALLER's promise bounds nothing. The
	// Worker is still running whatever went silent, still holding its handle,
	// and the next request would be posted into the same silence. Terminating
	// on the deadline is what makes the bound real rather than cosmetic.
	it("terminates the silent Worker when the deadline fires", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker, { requestTimeoutMs: 50 });
		const pending = client.readFile("catalog_meta.json");
		const assertion =
			expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError);
		await vi.advanceTimersByTimeAsync(51);
		await assertion;

		expect(fake.terminate).toHaveBeenCalledOnce();
		// And it latches: a request after the deadline must not be posted into
		// the Worker that was just released.
		await expect(client.readFile("b")).rejects.toBeInstanceOf(WorkerCrashError);
		expect(fake.sent).toHaveLength(1);
	});

	it("does not fire the deadline for a request that already answered", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker, { requestTimeoutMs: 50 });
		const pending = client.readFile("catalog_meta.json");
		const id = fake.sent[0]?.id ?? 0;
		fake.reply({
			ok: true,
			kind: "readFile",
			id,
			bytes: Uint8Array.from([7]),
		} as EngineResponse);
		await expect(pending).resolves.toEqual(Uint8Array.from([7]));
		// Advancing past the old deadline must leave the Worker alive and the
		// client usable. A settled promise alone cannot prove timer cleanup:
		// Promise settlement is idempotent, while the stale callback would still
		// terminate and latch the Worker.
		await vi.advanceTimersByTimeAsync(500);
		expect(fake.terminate).not.toHaveBeenCalled();

		const next = client.readFile("still-alive.json");
		const nextId = fake.sent[1]?.id ?? 0;
		fake.reply({
			ok: true,
			kind: "readFile",
			id: nextId,
			bytes: Uint8Array.from([8]),
		} as EngineResponse);
		await expect(next).resolves.toEqual(Uint8Array.from([8]));
		expect(fake.sent).toHaveLength(2);
	});
});

describe("replies are correlated, not trusted", () => {
	it("ignores a reply whose id nobody is awaiting", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.readFile("a");
		const realId = fake.sent[0]?.id ?? 0;
		// A stray/duplicate reply must not resolve the wrong promise.
		fake.reply({
			ok: true,
			kind: "readFile",
			id: realId + 999,
			bytes: Uint8Array.from([1]),
		} as EngineResponse);
		fake.reply({
			ok: true,
			kind: "readFile",
			id: realId,
			bytes: Uint8Array.from([2]),
		} as EngineResponse);
		await expect(pending).resolves.toEqual(Uint8Array.from([2]));
	});

	it("rejects when the Worker answers with an error envelope", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.sync("https://cdn.example", "/public.key");
		fake.reply({
			ok: false,
			kind: "sync",
			id: fake.sent[0]?.id ?? 0,
			error: {
				code: "integrity",
				message: "signature verification failed",
			},
		} as EngineResponse);
		const error = await pending.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(EngineOperationError);
		expect(error).toMatchObject({
			code: "integrity",
			message: "signature verification failed",
		});
	});

	it("rejects a well-formed reply of the WRONG kind", async () => {
		// ok:true is not enough — a readFile answer to a sync request is a bug,
		// and returning it would hand the caller the wrong bytes.
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.sync("https://cdn.example", "/public.key");
		fake.reply({
			ok: true,
			kind: "readFile",
			id: fake.sent[0]?.id ?? 0,
			bytes: Uint8Array.from([1]),
		} as EngineResponse);
		await expect(pending).rejects.toThrow("unexpected response kind");
	});

	it("gives every request a distinct id", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		// Swallow: dispose() below rejects these by design; the ids are the subject.
		client.readFile("a").catch(() => {});
		client.readFile("b").catch(() => {});
		const ids = fake.sent.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
		client.dispose();
	});
});

describe("dispose", () => {
	it("terminates the Worker and rejects everything in flight", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.readFile("a");
		client.dispose();
		await expect(pending).rejects.toBeInstanceOf(WorkerCrashError);
		expect(fake.terminate).toHaveBeenCalledOnce();
	});

	it("is idempotent — a second call does not terminate twice", () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client.dispose();
		client.dispose();
		expect(fake.terminate).toHaveBeenCalledOnce();
	});

	it("terminate() is the alias, and shares the same latch", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client.terminate();
		expect(fake.terminate).toHaveBeenCalledOnce();
		await expect(client.readFile("a")).rejects.toBeInstanceOf(WorkerCrashError);
	});
});

describe("sync identity and storage options", () => {
	it("sends the caller's expected bundle id and channel", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client
			.sync("https://cdn.example", "/public.key", {
				expectedBundleId: "my-bundle",
				expectedChannel: "beta",
				wantedPaths: ["catalog/"],
				cacheNamespace: "my-consumer",
				indexedDbLayout: {
					database: "legacy-cache-v1",
					store: "entries",
					separator: "/",
				},
			})
			.catch(() => {});
		expect(fake.sent[0]).toMatchObject({
			kind: "sync",
			expectedBundleId: "my-bundle",
			expectedChannel: "beta",
			wantedPaths: ["catalog/"],
			cacheNamespace: "my-consumer",
			indexedDbLayout: {
				database: "legacy-cache-v1",
				store: "entries",
				separator: "/",
			},
		});
		// 0.3.0 REVERSES the 0.2.x contract: there is no IndexedDB backend to
		// choose any more, so no storage-backend preference is ever sent.
		expect(fake.sent[0]).not.toHaveProperty("storageBackend");
		client.dispose();
	});

	it("omits identity pins when the caller does not configure them", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client.sync("https://cdn.example", "/public.key").catch(() => {});
		const sent = fake.sent[0] as unknown as Record<string, unknown>;
		expect(sent).not.toHaveProperty("expectedBundleId");
		expect(sent).not.toHaveProperty("expectedChannel");
		client.dispose();
	});

	it("preserves the legacy positional identity call shape", () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		client
			.sync("https://cdn.example", "/public.key", "my-bundle", "stable")
			.catch(() => {});
		expect(fake.sent[0]).toMatchObject({
			expectedBundleId: "my-bundle",
			expectedChannel: "stable",
		});
		client.dispose();
	});
});

describe("sync progress is an idle-timeout heartbeat", () => {
	it("re-arms the deadline for each progress event without settling the request", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const onProgress = vi.fn();
		const client = new EngineClient(fake.worker, { idleTimeoutMs: 50 });
		const pending = client.sync("https://cdn.example", "/public.key", {
			onProgress,
		});
		const id = fake.sent[0]?.id ?? 0;

		await vi.advanceTimersByTimeAsync(40);
		fake.reply({
			ok: true,
			id,
			kind: "syncProgress",
			progress: {
				phase: "chunks",
				fetchedChunks: 1,
				totalChunks: 2,
				bytesFetched: 5,
				bytesTotal: 20,
				bytesDone: 10,
			},
		});
		await vi.advanceTimersByTimeAsync(40);
		expect(fake.terminate).not.toHaveBeenCalled();
		expect(onProgress).toHaveBeenCalledOnce();

		fake.reply({
			ok: true,
			id,
			kind: "sync",
			result: {
				version: "v1",
				manifestHash: "a".repeat(64),
				chunksFetched: 1,
				chunksReused: 0,
				bytesFetched: 5,
				cacheBackend: "sqlite-opfs",
				cacheStorage: { persistence: "opfs", pool: "p", file: "/p.sqlite3" },
			},
		});
		await expect(pending).resolves.toMatchObject({
			cacheBackend: "sqlite-opfs",
		});
	});

	it("isolates a throwing progress observer from the sync result", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.sync("https://cdn.example", "/public.key", {
			onProgress: () => {
				throw new Error("render failed");
			},
		});
		const id = fake.sent[0]?.id ?? 0;
		fake.reply({
			ok: true,
			id,
			kind: "syncProgress",
			progress: { phase: "pointer", version: "v1" },
		});
		fake.reply({
			ok: true,
			id,
			kind: "sync",
			result: {
				version: "v1",
				manifestHash: "a".repeat(64),
				chunksFetched: 0,
				chunksReused: 0,
				bytesFetched: 0,
				cacheBackend: "sqlite-memory",
				cacheStorage: { persistence: "memory", reason: "opfs-unavailable" },
			},
		});

		await expect(pending).resolves.toMatchObject({ version: "v1" });
	});

	it("does not re-arm an unrelated read request", async () => {
		vi.useFakeTimers();
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker, { idleTimeoutMs: 50 });
		const pending = client.readFile("catalog_meta.json");
		const assertion =
			expect(pending).rejects.toBeInstanceOf(WorkerTimeoutError);
		await vi.advanceTimersByTimeAsync(40);
		fake.reply({
			ok: true,
			id: fake.sent[0]?.id ?? 0,
			kind: "syncProgress",
			progress: {
				phase: "chunks",
				fetchedChunks: 1,
				totalChunks: 1,
				bytesFetched: 5,
				bytesTotal: 10,
				bytesDone: 10,
			},
		});
		await vi.advanceTimersByTimeAsync(11);
		await assertion;
	});
});

describe("explicit cache clear", () => {
	it("sends the storage identity and resolves only a clear response", async () => {
		const fake = fakeWorker();
		const client = new EngineClient(fake.worker);
		const pending = client.clear({
			cacheNamespace: "my-consumer",
			indexedDbLayout: {
				database: "legacy-cache-v1",
				store: "entries",
				separator: "/",
			},
		});
		expect(fake.sent[0]).not.toHaveProperty("storageBackend");
		expect(fake.sent[0]).toMatchObject({
			kind: "clear",
			cacheNamespace: "my-consumer",
			indexedDbLayout: {
				database: "legacy-cache-v1",
				store: "entries",
				separator: "/",
			},
		});
		fake.reply({
			ok: true,
			id: fake.sent[0]?.id ?? 0,
			kind: "clear",
		});
		await expect(pending).resolves.toBeUndefined();
	});
});

describe("refusals the happy paths never reach", () => {
	it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		"refuses an idle timeout of %s",
		(idleTimeoutMs) => {
			expect(
				() => new EngineClient(fakeWorker().worker, { idleTimeoutMs }),
			).toThrow(new TypeError("idle timeout must be a positive safe integer"));
		},
	);

	it.each([
		[
			"readFile",
			(client: EngineClient) => client.readFile("catalog_meta.json"),
		],
		["clear", (client: EngineClient) => client.clear()],
	] as const)(
		"%s rejects with the Worker's typed error envelope",
		async (kind, call) => {
			const fake = fakeWorker();
			const pending = call(new EngineClient(fake.worker));
			fake.reply({
				ok: false,
				kind,
				id: fake.sent[0]?.id ?? 0,
				error: { code: "integrity", message: `${kind} refused` },
			} as EngineResponse);
			const error = await pending.catch((reason: unknown) => reason);
			expect(error).toBeInstanceOf(EngineOperationError);
			expect(error).toMatchObject({
				code: "integrity",
				message: `${kind} refused`,
			});
		},
	);
});
