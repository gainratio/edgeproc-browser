import { describe, expect, it } from "vitest";
import { verifyEd25519 } from "./crypto.js";
import {
	catalogFetch,
	latestBytes,
	manifestBytes,
	pubkeyRaw,
} from "./fixtures.js";
import { MemoryCacheStore } from "./memoryStore.js";
import { StorageQuotaError } from "./storageError.js";
import { materializeFile, type SyncProgress, syncIndex } from "./sync.js";
import type { IndexManifest, Verify, VersionPointer } from "./types.js";

const DECODER = new TextDecoder();
const verify: Verify = (message, signature) =>
	verifyEd25519(pubkeyRaw(), message, signature);

function activeManifest(): IndexManifest {
	const pointer = JSON.parse(DECODER.decode(latestBytes())) as VersionPointer;
	return JSON.parse(
		DECODER.decode(manifestBytes(pointer.manifest_hash)),
	) as IndexManifest;
}

describe("consumer sync contract", () => {
	it("fetches and verifies only signed files selected by wantedPaths", async () => {
		const all = catalogFetch();
		const fullStore = new MemoryCacheStore();
		await syncIndex({
			baseUrl: "/cat",
			store: fullStore,
			fetchBytes: all.fetchBytes,
			verify,
		});

		const selected = catalogFetch();
		const selectedStore = new MemoryCacheStore();
		const progress: SyncProgress[] = [];
		const result = await syncIndex({
			baseUrl: "/cat",
			store: selectedStore,
			fetchBytes: selected.fetchBytes,
			verify,
			wantedPaths: ["catalog_meta.json"],
			onProgress: (event) => progress.push(event),
		});

		expect(selected.chunkRequests().length).toBeLessThan(
			all.chunkRequests().length,
		);
		expect(result.chunksFetched).toBe(selected.chunkRequests().length);
		expect(progress.map((event) => event.phase)).toEqual([
			"pointer",
			"manifest",
			"chunks",
			"verify",
			"promoted",
		]);
		const manifest = activeManifest();
		await expect(
			materializeFile(selectedStore, manifest, "catalog_meta.json"),
		).resolves.toBeInstanceOf(Uint8Array);
		const omitted = manifest.files.find(
			(entry) => entry.path !== "catalog_meta.json",
		);
		expect(omitted).toBeDefined();
		await expect(
			materializeFile(selectedStore, manifest, omitted?.path ?? "missing"),
		).rejects.toThrow();
	});

	it("accepts signed directory prefixes and reports each fetched verified chunk", async () => {
		const manifest = activeManifest();
		const image = manifest.files.find((entry) => entry.path.includes("/"));
		expect(image).toBeDefined();
		const prefix = `${image?.path.split("/")[0] ?? "missing"}/`;
		const fixture = catalogFetch();
		const chunks: Extract<SyncProgress, { phase: "chunks" }>[] = [];
		const result = await syncIndex({
			baseUrl: "/cat",
			store: new MemoryCacheStore(),
			fetchBytes: fixture.fetchBytes,
			verify,
			wantedPaths: [prefix],
			onProgress: (progress) => {
				if (progress.phase === "chunks") chunks.push(progress);
			},
		});

		expect(result.chunksFetched).toBeGreaterThan(0);
		expect(chunks).toHaveLength(result.chunksFetched);
		expect(chunks.at(-1)).toMatchObject({
			fetchedChunks: result.chunksFetched,
			totalChunks: result.chunksFetched,
			bytesFetched: result.bytesFetched,
		});
	});

	it("rejects unsafe, duplicate, or unsigned selected paths before chunk fetch", async () => {
		for (const wantedPaths of [
			["../escape"],
			["catalog_meta.json", "catalog_meta.json"],
			["not-in-the-signed-manifest"],
		]) {
			const fixture = catalogFetch();
			await expect(
				syncIndex({
					baseUrl: "/cat",
					store: new MemoryCacheStore(),
					fetchBytes: fixture.fetchBytes,
					verify,
					wantedPaths,
				}),
			).rejects.toThrow();
			expect(fixture.chunkRequests()).toEqual([]);
		}
	});

	it("expands a catalog-only promotion with selected chunks for the same pointer", async () => {
		const store = new MemoryCacheStore();
		const catalogOnly = catalogFetch();
		await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: catalogOnly.fetchBytes,
			verify,
			wantedPaths: [],
		});
		expect(catalogOnly.chunkRequests()).toEqual([]);

		const selected = catalogFetch();
		const expanded = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: selected.fetchBytes,
			verify,
			wantedPaths: ["catalog_meta.json"],
		});
		expect(expanded.chunksFetched).toBeGreaterThan(0);
		expect(selected.chunkRequests().length).toBe(expanded.chunksFetched);

		const repeated = catalogFetch();
		const unchanged = await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: repeated.fetchBytes,
			verify,
			wantedPaths: ["catalog_meta.json"],
		});
		expect(unchanged.chunksFetched).toBe(0);
		expect(repeated.chunkRequests()).toEqual([]);
	});

	it("treats null identity pins as exact legacy-identity requirements", async () => {
		const legacy = {
			...(JSON.parse(DECODER.decode(latestBytes())) as VersionPointer),
			bundle_id: null,
			channel: null,
		};
		const fixture = catalogFetch();
		const fetchBytes = (url: string): Promise<Uint8Array> =>
			url.endsWith("/latest")
				? Promise.resolve(new TextEncoder().encode(JSON.stringify(legacy)))
				: fixture.fetchBytes(url);
		await expect(
			syncIndex({
				baseUrl: "/cat",
				store: new MemoryCacheStore(),
				fetchBytes,
				verify: () => Promise.resolve(),
				expectedBundleId: null,
				expectedChannel: null,
				wantedPaths: [],
			}),
		).resolves.toMatchObject({ version: "v1", chunksFetched: 0 });

		await expect(
			syncIndex({
				baseUrl: "/cat",
				store: new MemoryCacheStore(),
				fetchBytes,
				verify: () => Promise.resolve(),
				expectedBundleId: "identified-bundle",
				wantedPaths: [],
			}),
		).rejects.toThrow(/bundle identity/iu);
	});

	it("conditionally clears only the exact active memory pointer", async () => {
		const store = new MemoryCacheStore();
		const active: VersionPointer = {
			manifest_hash: "a".repeat(64),
			version: "v1",
			sequence: 1,
			signature: "signed",
		};
		await store.promote(active);
		expect(
			await store.clearActiveIf({ ...active, manifest_hash: "b".repeat(64) }),
		).toBe(false);
		expect(await store.clearActiveIf(active)).toBe(true);
		expect(await store.readActive()).toBeNull();
		await expect(store.pruneInactive()).resolves.toBeUndefined();
	});

	it("preserves the quota error when the requested scope is not fully cached", async () => {
		class QuotaStore extends MemoryCacheStore {
			public refuseChunks = false;

			public override putChunkCompressed(
				hash: string,
				compressed: Uint8Array,
				expectedSize: number,
			): Promise<void> {
				return this.refuseChunks
					? Promise.reject(new StorageQuotaError())
					: super.putChunkCompressed(hash, compressed, expectedSize);
			}
		}
		const store = new QuotaStore();
		await syncIndex({
			baseUrl: "/cat",
			store,
			fetchBytes: catalogFetch().fetchBytes,
			verify,
			wantedPaths: [],
		});
		store.refuseChunks = true;

		await expect(
			syncIndex({
				baseUrl: "/cat",
				store,
				fetchBytes: catalogFetch().fetchBytes,
				verify,
				wantedPaths: ["catalog_meta.json"],
			}),
		).rejects.toBeInstanceOf(StorageQuotaError);
	});
});
