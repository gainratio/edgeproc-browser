// Cold sync through a batch-capable store: verified chunks reach storage in a
// few large writes instead of one storage round trip per chunk, while the
// fail-closed contract is unchanged (a substituted chunk is refused and
// nothing is promoted). Stores without the batch method keep the per-chunk
// path, so third-party CacheStore implementations are unaffected.

import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { verifyEd25519 } from "./crypto.js";
import { catalogFetch, pubkeyRaw, signedChunkRefs } from "./fixtures.js";
import { IntegrityError } from "./integrity.js";
import { MemoryCacheStore } from "./memoryStore.js";
import { openPersistentCacheStore } from "./persistentStore.js";
import { StorageQuotaError } from "./storageError.js";
import {
	MAX_STORE_BATCH_BYTES,
	MAX_STORE_BATCH_CHUNKS,
	materializeFile,
	type SyncProgress,
	syncIndex,
} from "./sync.js";
import type {
	CacheStore,
	CompressedChunk,
	IndexManifest,
	Verify,
} from "./types.js";

const PUBKEY = pubkeyRaw();
const verify: Verify = (message, signature) =>
	verifyEd25519(PUBKEY, message, signature);
const DISTINCT = new Set(signedChunkRefs().map((ref) => ref.hash)).size;

/** A memory store that records how chunks arrive. */
class BatchingStore extends MemoryCacheStore {
	public readonly batches: number[] = [];
	public singlePuts = 0;
	#inBatch = false;

	public override async putChunkCompressed(
		hash: string,
		compressed: Uint8Array,
		size: number,
	): Promise<void> {
		if (!this.#inBatch) this.singlePuts += 1;
		await super.putChunkCompressed(hash, compressed, size);
	}

	public async putChunksCompressed(
		chunks: ReadonlyArray<CompressedChunk>,
	): Promise<void> {
		this.batches.push(chunks.length);
		this.#inBatch = true;
		try {
			for (const chunk of chunks) {
				await super.putChunkCompressed(
					chunk.hash,
					chunk.compressed,
					chunk.size,
				);
			}
		} finally {
			this.#inBatch = false;
		}
	}
}

describe("batched chunk storage during sync", () => {
	it("pins the batch bounds", () => {
		expect(MAX_STORE_BATCH_CHUNKS).toBe(128);
		expect(MAX_STORE_BATCH_BYTES).toBe(4 * 1024 * 1024);
	});

	it("stores a cold sync in a few batches, never one write per chunk", async () => {
		const store = new BatchingStore();
		const progress: SyncProgress[] = [];
		const result = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: catalogFetch().fetchBytes,
			verify,
			onProgress: (event) => progress.push(event),
		});

		expect(result.chunksFetched).toBe(DISTINCT);
		expect(store.singlePuts).toBe(0);
		expect(store.batches.reduce((sum, size) => sum + size, 0)).toBe(DISTINCT);
		expect(store.batches.length).toBe(
			Math.ceil(DISTINCT / MAX_STORE_BATCH_CHUNKS),
		);
		const chunkEvents = progress.filter((event) => event.phase === "chunks");
		const last = chunkEvents.at(-1);
		expect(last).toMatchObject({
			fetchedChunks: DISTINCT,
			totalChunks: DISTINCT,
		});
		const manifest = JSON.parse(
			new TextDecoder().decode(await store.getManifest(result.manifestHash)),
		) as IndexManifest;
		for (const entry of manifest.files) {
			const bytes = await materializeFile(store, manifest, entry.path);
			expect(bytes.byteLength).toBe(entry.size);
		}
	});

	it("refuses a substituted chunk in a batch and promotes nothing", async () => {
		const store = new BatchingStore();
		const { fetchBytes } = catalogFetch();
		const [victim, substitute] = [
			...new Set(signedChunkRefs().map((ref) => ref.hash)),
		];
		const forged = (url: string) =>
			fetchBytes(
				url.endsWith(`/chunk/${victim}`)
					? url.replace(victim ?? "", substitute ?? "")
					: url,
			);

		await expect(
			syncIndex({ baseUrl: "/cat", store, fetchBytes: forged, verify }),
		).rejects.toBeInstanceOf(IntegrityError);
		expect(await store.readActive()).toBeNull();
		expect(await store.hasChunk(victim ?? "")).toBe(false);
	});

	it("surfaces a storage failure in the final partial batch", async () => {
		const store = new BatchingStore();
		const failing = Object.assign(store, {
			putChunksCompressed: vi.fn(() =>
				Promise.reject(new Error("disk unplugged")),
			),
		});

		await expect(
			syncIndex({
				baseUrl: "/cat",
				store: failing,
				fetchBytes: catalogFetch().fetchBytes,
				verify,
				wantedPaths: ["catalog_meta.json"],
			}),
		).rejects.toThrow("disk unplugged");
		expect(await store.readActive()).toBeNull();
	});
});

describe("the persistent store forwards batches to OPFS", () => {
	it("hands a batch to a batch-capable primary and never to the floor", async () => {
		const primary = new BatchingStore();
		const floor = Object.assign(new BatchingStore(), {
			cacheBackend: "indexeddb" as const,
		});
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(primary),
				openIndexedDb: () => Promise.resolve(floor),
			},
		});

		await syncIndex({
			baseUrl: "/cat",
			store: selected,
			fetchBytes: catalogFetch().fetchBytes,
			verify,
		});

		expect(primary.batches.reduce((sum, size) => sum + size, 0)).toBe(DISTINCT);
		expect(floor.batches).toEqual([]);
		expect(floor.singlePuts).toBe(0);
	});

	it("falls back to per-chunk writes for a primary without batches", async () => {
		const primary = new MemoryCacheStore();
		const puts = vi.spyOn(primary, "putChunkCompressed");
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(primary),
				openIndexedDb: () =>
					Promise.resolve(
						Object.assign(new MemoryCacheStore(), {
							cacheBackend: "indexeddb" as const,
						}),
					),
			},
		});

		await syncIndex({
			baseUrl: "/cat",
			store: selected,
			fetchBytes: catalogFetch().fetchBytes,
			verify,
		});

		expect(puts).toHaveBeenCalledTimes(DISTINCT);
	});

	it("prunes and retries a batch once on a quota failure", async () => {
		const primary = new BatchingStore();
		let attempts = 0;
		const batch = primary.putChunksCompressed.bind(primary);
		const prunes = vi.spyOn(primary, "pruneInactive");
		const flaky: CacheStore & {
			putChunksCompressed(
				chunks: ReadonlyArray<CompressedChunk>,
			): Promise<void>;
		} = Object.assign(primary, {
			putChunksCompressed: (chunks: ReadonlyArray<CompressedChunk>) => {
				attempts += 1;
				return attempts === 1
					? Promise.reject(new StorageQuotaError())
					: batch(chunks);
			},
		});
		const selected = await openPersistentCacheStore({
			openers: {
				openOpfs: () => Promise.resolve(flaky),
				openIndexedDb: () =>
					Promise.resolve(
						Object.assign(new MemoryCacheStore(), {
							cacheBackend: "indexeddb" as const,
						}),
					),
			},
		});

		await selected.putChunksCompressed?.([]);
		expect(attempts).toBe(2);
		expect(prunes).toHaveBeenCalledOnce();
	});
});
