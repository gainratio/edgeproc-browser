// Cold-sync throughput harness, run inside a dedicated Worker (OPFS sync
// access handles are Worker-only). It drives the REAL syncIndex over the REAL
// production store (OPFS + IndexedDB floor) against the committed signed
// bundle served over plain HTTP, and splits the wall clock into phases:
//
//   fetch   - time inside fetchBytes (network)
//   verify  - zstd decompress + SHA-256 per chunk, timed in isolation
//   write   - store.putChunkCompressed minus the isolated verify cost
//   probe   - store.hasChunk (cold-boot presence probes)
//   reread  - the post-fetch reassembly pass (store.getChunk)
//
// Accumulated times overlap under concurrency; `wallMs` is the honest total.

import { fetchBytes } from "../../src/engine/fetchBytes.js";
import { decompressAndVerify } from "../../src/engine/integrity.js";
import { loadTrustRoot } from "../../src/engine/keyring.js";
import { openPersistentCacheStore } from "../../src/engine/persistentStore.js";
import { type SyncProgress, syncIndex } from "../../src/engine/sync.js";
import type { CacheStore, FetchBytes } from "../../src/engine/types.js";

export interface PhaseTimings {
	readonly backend: string;
	readonly wallMs: number;
	readonly chunksFetched: number;
	readonly fetchMs: number;
	readonly probeMs: number;
	readonly putMs: number;
	readonly verifyMs: number;
	readonly rereadMs: number;
	readonly chunkPhaseWallMs: number;
	readonly verifyPhaseWallMs: number;
}

export interface TamperResult {
	readonly outcome: string;
	readonly promoted: boolean;
}

export type ThroughputRequest =
	| {
			readonly kind: "cold";
			readonly baseUrl: string;
			readonly keyUrl: string;
			readonly backend: "auto" | "indexeddb";
	  }
	| {
			readonly kind: "tamper";
			readonly baseUrl: string;
			readonly keyUrl: string;
			readonly tamperHash: string;
			readonly substituteHash: string;
	  };

class Clock {
	public total = 0;
	public async time<T>(operation: () => Promise<T>): Promise<T> {
		const started = performance.now();
		try {
			return await operation();
		} finally {
			this.total += performance.now() - started;
		}
	}
}

async function wipeOpfs(): Promise<void> {
	let root: FileSystemDirectoryHandle;
	try {
		root = await navigator.storage.getDirectory();
	} catch {
		return; // Ephemeral WebKit has no OPFS; the store falls back to IndexedDB.
	}
	for await (const [name] of root.entries()) {
		await root.removeEntry(name, { recursive: true });
	}
}

async function wipeOrigin(): Promise<void> {
	await wipeOpfs();
	const databases = (await indexedDB.databases?.()) ?? [];
	await Promise.all(
		databases.map(
			(database) =>
				new Promise<void>((resolve) => {
					const request = indexedDB.deleteDatabase(database.name ?? "");
					request.onsuccess = () => resolve();
					request.onerror = () => resolve();
					request.onblocked = () => resolve();
				}),
		),
	);
}

interface Instrumented {
	readonly store: CacheStore;
	readonly fetch: FetchBytes;
	readonly chunks: Map<string, { bytes: Uint8Array; size: number }>;
	readonly clocks: Record<"fetch" | "probe" | "put" | "reread", Clock>;
}

function instrument(store: CacheStore): Instrumented {
	const clocks = {
		fetch: new Clock(),
		probe: new Clock(),
		put: new Clock(),
		reread: new Clock(),
	};
	const chunks = new Map<string, { bytes: Uint8Array; size: number }>();
	const wrapped: CacheStore = {
		hasChunk: (hash) => clocks.probe.time(() => store.hasChunk(hash)),
		putChunkCompressed: (hash, bytes, size) => {
			chunks.set(hash, { bytes, size });
			return clocks.put.time(() => store.putChunkCompressed(hash, bytes, size));
		},
		getChunk: (hash, size) =>
			clocks.reread.time(() => store.getChunk(hash, size)),
		putManifest: (bytes) => store.putManifest(bytes),
		getManifest: (hash) => store.getManifest(hash),
		readActive: () => store.readActive(),
		promote: (pointer) => store.promote(pointer),
		clearActiveIf: (pointer) => store.clearActiveIf(pointer),
		pruneInactive: () => store.pruneInactive(),
		clear: () => store.clear(),
	};
	if ("putChunksCompressed" in store) {
		const batch = (store as BatchStore).putChunksCompressed.bind(store);
		(wrapped as BatchStore).putChunksCompressed = (items) => {
			for (const item of items) {
				chunks.set(item.hash, { bytes: item.compressed, size: item.size });
			}
			return clocks.put.time(() => batch(items));
		};
	}
	const fetch: FetchBytes = (url, options) =>
		clocks.fetch.time(() => fetchBytes(url, options));
	return { store: wrapped, fetch, chunks, clocks };
}

interface BatchStore extends CacheStore {
	putChunksCompressed(
		items: ReadonlyArray<{
			readonly hash: string;
			readonly compressed: Uint8Array;
			readonly size: number;
		}>,
	): Promise<void>;
}

async function isolatedVerifyMs(
	chunks: Map<string, { bytes: Uint8Array; size: number }>,
): Promise<number> {
	const started = performance.now();
	for (const [hash, { bytes, size }] of chunks) {
		await decompressAndVerify(hash, bytes, size);
	}
	return performance.now() - started;
}

function phaseWall(events: ReadonlyArray<[string, number]>, phase: string) {
	const times = events.filter(([name]) => name === phase).map(([, t]) => t);
	return times.length === 0 ? 0 : Math.max(...times) - Math.min(...times);
}

async function cold(
	baseUrl: string,
	keyUrl: string,
	storageBackend: "auto" | "indexeddb",
): Promise<PhaseTimings> {
	await wipeOrigin();
	const store = await openPersistentCacheStore({
		namespace: "throughput",
		storageBackend,
	});
	const probe = instrument(store);
	const keyring = await loadTrustRoot(keyUrl, fetchBytes);
	const events: Array<[string, number]> = [];
	const started = performance.now();
	const result = await syncIndex({
		baseUrl,
		store: probe.store,
		fetchBytes: probe.fetch,
		keyring,
		onProgress: (progress: SyncProgress) =>
			events.push([progress.phase, performance.now()]),
	});
	const wallMs = performance.now() - started;
	return {
		backend: store.cacheBackend,
		wallMs,
		chunksFetched: result.chunksFetched,
		fetchMs: probe.clocks.fetch.total,
		probeMs: probe.clocks.probe.total,
		putMs: probe.clocks.put.total,
		verifyMs: await isolatedVerifyMs(probe.chunks),
		rereadMs: probe.clocks.reread.total,
		chunkPhaseWallMs: phaseWall(events, "chunks"),
		verifyPhaseWallMs: phaseWall(events, "verify"),
	};
}

/** Serve one chunk as ANOTHER chunk's bytes: a valid zstd frame of different
 * content (the attack the hash check exists for). Reports the refusal and
 * whether anything was promoted. */
async function tamper(
	baseUrl: string,
	keyUrl: string,
	tamperHash: string,
	substituteHash: string,
): Promise<TamperResult> {
	await wipeOrigin();
	const store = await openPersistentCacheStore({ namespace: "throughput" });
	const keyring = await loadTrustRoot(keyUrl, fetchBytes);
	const forged: FetchBytes = async (url, options) => {
		if (url.endsWith(`/chunk/${tamperHash}`)) {
			return fetchBytes(url.replace(tamperHash, substituteHash), options);
		}
		return fetchBytes(url, options);
	};
	let outcome = "accepted";
	try {
		await syncIndex({ baseUrl, store, fetchBytes: forged, keyring });
	} catch (error) {
		outcome = error instanceof Error ? error.name : String(error);
	}
	return { outcome, promoted: (await store.readActive()) !== null };
}

self.onmessage = async (event: MessageEvent<ThroughputRequest>) => {
	const request = event.data;
	try {
		const result =
			request.kind === "cold"
				? await cold(request.baseUrl, request.keyUrl, request.backend)
				: await tamper(
						request.baseUrl,
						request.keyUrl,
						request.tamperHash,
						request.substituteHash,
					);
		self.postMessage({ ok: true, result });
	} catch (error) {
		self.postMessage({
			ok: false,
			error: error instanceof Error ? `${error.name}: ${error.message}` : error,
		});
	}
};
