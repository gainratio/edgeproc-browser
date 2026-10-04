import { samePointer } from "./activePointer.js";
import { cacheDatabaseName, validatedNamespace } from "./cacheLock.js";
import {
	IndexedDbCacheStore,
	type IndexedDbLayoutOptions,
	resolveIndexedDbLayout,
} from "./indexedDbStore.js";
import { IntegrityError } from "./integrity.js";
import { OpfsCacheStore, selectHighestPointer } from "./opfsStore.js";
import { StorageQuotaError } from "./storageError.js";
import type {
	CacheBackend,
	CacheStore,
	CompressedChunk,
	StoragePreference,
	VersionPointer,
} from "./types.js";

export type { CacheBackend, StoragePreference } from "./types.js";

export interface PersistentCacheStore extends CacheStore {
	readonly cacheBackend: CacheBackend;
}

export interface PersistentStoreOpeners {
	readonly openOpfs: () => Promise<CacheStore>;
	readonly openIndexedDb: () => Promise<PersistentCacheStore>;
}

export interface PersistentStoreOptions {
	readonly namespace?: string;
	readonly storageBackend?: StoragePreference;
	readonly indexedDbLayout?: IndexedDbLayoutOptions;
	readonly openers?: PersistentStoreOpeners;
}

export function requestPersistentStorage(
	storage: Pick<StorageManager, "persist"> | undefined,
): void {
	void storage?.persist?.().catch(() => false);
}

export async function openPersistentCacheStore(
	options: PersistentStoreOptions = {},
): Promise<PersistentCacheStore> {
	const namespace = validatedNamespace(options.namespace ?? "edgeproc-browser");
	const indexedDbLayout = resolveIndexedDbLayout(
		options.indexedDbLayout,
		cacheDatabaseName(namespace),
	);
	const openers = options.openers ?? {
		// Keep the historical origin-root OPFS layout for upgrade compatibility.
		// The namespace scopes the Web Lock and IndexedDB rollback floor.
		openOpfs: () => OpfsCacheStore.open(),
		openIndexedDb: () => IndexedDbCacheStore.open(indexedDbLayout),
	};
	let indexedDb: PersistentCacheStore;
	try {
		indexedDb = await openers.openIndexedDb();
	} catch (error) {
		throw new Error("persistent rollback floor unavailable", { cause: error });
	}
	if (options.storageBackend === "indexeddb") return indexedDb;
	try {
		return new CoordinatedCacheStore(await openers.openOpfs(), indexedDb);
	} catch {
		return indexedDb;
	}
}

class CoordinatedCacheStore implements PersistentCacheStore {
	public readonly cacheBackend = "opfs+indexeddb" as const;
	readonly #primary: CacheStore;
	readonly #floor: CacheStore;

	public constructor(primary: CacheStore, floor: CacheStore) {
		this.#primary = primary;
		this.#floor = floor;
	}

	public async hasChunk(hash: string): Promise<boolean> {
		const [primary, floor] = await Promise.all([
			this.#primary.hasChunk(hash),
			this.#floor.hasChunk(hash),
		]);
		return primary || floor;
	}

	public async putChunkCompressed(
		hash: string,
		compressed: Uint8Array,
		expectedSize: number,
	): Promise<void> {
		await this.#retryQuota(() =>
			this.#primary.putChunkCompressed(hash, compressed, expectedSize),
		);
	}

	/** Batches go to the primary only, like single chunks; a primary without
	 * batch support gets one put per chunk. */
	public async putChunksCompressed(
		chunks: ReadonlyArray<CompressedChunk>,
	): Promise<void> {
		const primary = this.#primary;
		const putBatch = primary.putChunksCompressed;
		await this.#retryQuota(async () => {
			if (putBatch !== undefined) {
				await putBatch.call(primary, chunks);
				return;
			}
			for (const chunk of chunks) {
				await primary.putChunkCompressed(
					chunk.hash,
					chunk.compressed,
					chunk.size,
				);
			}
		});
	}

	public async getChunk(
		hash: string,
		expectedSize: number,
	): Promise<Uint8Array> {
		try {
			return await this.#primary.getChunk(hash, expectedSize);
		} catch {
			return this.#floor.getChunk(hash, expectedSize);
		}
	}

	public async putManifest(bytes: Uint8Array): Promise<string> {
		return this.#retryQuota(() => this.#primary.putManifest(bytes));
	}

	public async getManifest(hash: string): Promise<Uint8Array> {
		try {
			return await this.#primary.getManifest(hash);
		} catch {
			return this.#floor.getManifest(hash);
		}
	}

	public async readActive(): Promise<VersionPointer | null> {
		const [primary, floor] = await Promise.all([
			this.#primary.readActive(),
			this.#floor.readActive(),
		]);
		if (
			primary !== null &&
			floor !== null &&
			primary.sequence === floor.sequence &&
			!samePointer(primary, floor)
		) {
			throw new IntegrityError("persistent cache rollback floors disagree");
		}
		return selectHighestPointer([primary, floor]);
	}

	public async promote(pointer: VersionPointer): Promise<void> {
		await this.#floor.promote(pointer);
		await this.#primary.promote(pointer);
	}

	public async clearActiveIf(expected: VersionPointer): Promise<boolean> {
		const [floor, primary] = await Promise.all([
			this.#floor.clearActiveIf(expected),
			this.#primary.clearActiveIf(expected),
		]);
		return floor || primary;
	}

	public async pruneInactive(): Promise<void> {
		await Promise.all([
			this.#floor.pruneInactive(),
			this.#primary.pruneInactive(),
		]);
	}

	public async clear(): Promise<void> {
		await Promise.all([this.#floor.clear(), this.#primary.clear()]);
	}

	async #retryQuota<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (!(error instanceof StorageQuotaError)) throw error;
			await this.#primary.pruneInactive();
			return operation();
		}
	}
}
