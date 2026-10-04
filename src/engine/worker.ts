// The sync engine's Worker entry. It owns the SQLite chunk database (opfs-sahpool
// needs Worker-only sync access handles) and the engine; the main thread drives it over postMessage.
// One concern: route a request to the engine, reply with a typed envelope.

/// <reference lib="webworker" />

import { openSqlStorage } from "../sql/open.js";
import type { SqlStorage } from "../sql/types.js";
import { loadSqlite, workerStorageDeps } from "../sql/workerRuntime.js";
import { resolveMemoryProfile } from "../sqlite/memoryProfile.js";
import { cacheDatabaseName, runWithCacheLock } from "./cacheLock.js";
import { ChunkDatabase, type ChunkOperation } from "./chunkDatabase.js";
import { classifyEngineError } from "./engineError.js";
import { fetchBytes } from "./fetchBytes.js";
import { loadTrustRoot } from "./keyring.js";
import {
	type IndexedDbLayout,
	type IndexedDbLayoutOptions,
	indexedDbLegacySource,
	opfsLegacySource,
	resolveIndexedDbLayout,
} from "./legacyStores.js";
import { installNetworkSentinel } from "./networkSentinel.js";
import type {
	ClearRequest,
	EngineRequest,
	EngineResponse,
	ReadFileRequest,
	SyncRequest,
} from "./protocol.js";
import type { SqliteCacheStore } from "./sqliteStore.js";
import { materializeFile, syncIndex } from "./sync.js";
import type { CacheBackend, IndexManifest, VersionPointer } from "./types.js";

const DECODER = new TextDecoder();
/** Operations are serialized by the cache lock first, so a pool owner that
 * outlasts this is a foreign context (or a page that never closed it). */
const POOL_WAIT_MS = 5_000;

// This Worker fetches the signed bundle, so its traffic must be visible to the
// tab's network counter — the window cannot see a Worker's resource timeline.
installNetworkSentinel("engine-worker");

interface StoreConfiguration {
	readonly namespace: string;
	readonly indexedDbLayout: IndexedDbLayout;
}

let storeState:
	| (StoreConfiguration & { readonly database: ChunkDatabase })
	| null = null;

/** The Worker's chunk database. Its configuration is fixed by first use. */
function chunks(configuration?: {
	readonly namespace?: string;
	readonly indexedDbLayout?: IndexedDbLayoutOptions;
}): StoreConfiguration & { readonly database: ChunkDatabase } {
	const namespace = configuration?.namespace ?? "edgeproc-browser";
	const indexedDbLayout = resolveIndexedDbLayout(
		configuration?.indexedDbLayout,
		cacheDatabaseName(namespace),
	);
	if (storeState === null) {
		storeState = {
			namespace,
			indexedDbLayout,
			database: new ChunkDatabase({
				namespace,
				open: async (name) =>
					openSqlStorage(workerStorageDeps(await loadSqlite(), POOL_WAIT_MS), {
						name,
						fallback: "memory",
					}),
				memoryProfile: resolveMemoryProfile("auto"),
				legacySources: () => [
					opfsLegacySource(),
					indexedDbLegacySource(indexedDbLayout),
				],
				warn: (message) => console.warn(message),
				withLock: (operation) =>
					runWithCacheLock(lockManager(), operation, namespace),
			}),
		};
	} else if (
		storeState.namespace !== namespace ||
		storeState.indexedDbLayout.database !== indexedDbLayout.database ||
		storeState.indexedDbLayout.store !== indexedDbLayout.store ||
		storeState.indexedDbLayout.separator !== indexedDbLayout.separator
	) {
		throw new Error(
			"engine worker cache configuration cannot change after first use",
		);
	}
	return storeState;
}

/** Queue on the chunk database: it takes the cross-tab lock, then the pool. */
function withChunkStore<T>(
	configuration: StoreConfiguration & { readonly database: ChunkDatabase },
	operation: ChunkOperation<T>,
	shared = false,
): Promise<T> {
	return configuration.database.run(operation, { shared });
}

function backendOf(storage: SqlStorage): CacheBackend {
	return storage.persistence === "opfs" ? "sqlite-opfs" : "sqlite-memory";
}

async function handleSync(req: SyncRequest): Promise<EngineResponse> {
	requestPersistentStorage();
	const configuration = chunks({
		namespace: req.cacheNamespace ?? "edgeproc-browser",
		...(req.indexedDbLayout === undefined
			? {}
			: { indexedDbLayout: req.indexedDbLayout }),
	});
	return withChunkStore(configuration, async (cacheStore, storage) => {
		// The trust root: a legacy raw 32-byte key (a keyring of one) or an
		// edgeproc.keyring/v1 JSON document, fetched no-store and size-capped.
		const keyring = await loadTrustRoot(req.pubkeyUrl, fetchBytes);
		const result = await syncIndex({
			baseUrl: req.baseUrl,
			store: cacheStore,
			fetchBytes,
			keyring,
			...(req.expectedBundleId === undefined
				? {}
				: { expectedBundleId: req.expectedBundleId }),
			...(req.expectedChannel === undefined
				? {}
				: { expectedChannel: req.expectedChannel }),
			...(req.wantedPaths === undefined
				? {}
				: { wantedPaths: req.wantedPaths }),
			onProgress: (progress) => {
				self.postMessage({
					ok: true,
					id: req.id,
					kind: "syncProgress",
					progress,
				} satisfies EngineResponse);
			},
		});
		return {
			ok: true,
			id: req.id,
			kind: "sync",
			result: {
				...result,
				cacheBackend: backendOf(storage),
				cacheStorage: storage,
			},
		};
	});
}

async function handleReadFile(req: ReadFileRequest): Promise<EngineResponse> {
	return withChunkStore(
		storeState ?? chunks(),
		async (cacheStore) => {
			const manifest = await loadActiveManifest(cacheStore);
			const bytes = await materializeFile(cacheStore, manifest, req.path);
			return { ok: true, id: req.id, kind: "readFile", bytes };
		},
		true,
	);
}

async function handleClear(req: ClearRequest): Promise<EngineResponse> {
	const indexedDbLayout = req.indexedDbLayout ?? storeState?.indexedDbLayout;
	const configuration = chunks({
		namespace:
			req.cacheNamespace ?? storeState?.namespace ?? "edgeproc-browser",
		...(indexedDbLayout === undefined ? {} : { indexedDbLayout }),
	});
	return withChunkStore(configuration, async (cacheStore) => {
		await cacheStore.clear();
		return { ok: true, id: req.id, kind: "clear" };
	});
}

/** Ask the browser not to evict this origin's storage (best effort). */
function requestPersistentStorage(): void {
	void navigator.storage?.persist?.().catch(() => false);
}

async function loadActiveManifest(
	cacheStore: SqliteCacheStore,
): Promise<IndexManifest> {
	const active: VersionPointer | null = await cacheStore.readActive();
	if (active === null) {
		throw new Error("no active version — sync first");
	}
	const raw = await cacheStore.getManifest(active.manifest_hash);
	const manifest = JSON.parse(DECODER.decode(raw)) as IndexManifest;
	return manifest;
}

function lockManager():
	| { request<T>(name: string, operation: () => Promise<T>): Promise<T> }
	| undefined {
	return navigator.locks === undefined
		? undefined
		: {
				request: (name, operation) => navigator.locks.request(name, operation),
			};
}

async function handle(req: EngineRequest): Promise<EngineResponse> {
	switch (req.kind) {
		case "sync":
			return handleSync(req);
		case "readFile":
			return handleReadFile(req);
		case "clear":
			return handleClear(req);
	}
}

self.addEventListener("message", (event: MessageEvent<EngineRequest>) => {
	const req = event.data;
	handle(req)
		.then((response) => {
			if (response.ok && response.kind === "readFile") {
				self.postMessage(response, { transfer: [response.bytes.buffer] });
				return;
			}
			self.postMessage(response);
		})
		.catch((error: unknown) => {
			const response: EngineResponse = {
				ok: false,
				id: req.id,
				kind: req.kind,
				error: classifyEngineError(error),
			};
			self.postMessage(response);
		});
});
