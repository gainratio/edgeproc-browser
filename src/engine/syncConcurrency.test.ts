// Warm-boot performance contract: cached chunks are read and re-verified with
// BOUNDED concurrency (not one at a time), results keep manifest order, and a
// single bad chunk still fails the whole sync closed with a named error.

import { beforeAll, describe, expect, it } from "vitest";
import { verifyEd25519 } from "./crypto.js";
import { catalogFetch, latestBytes, pubkeyRaw } from "./fixtures.js";
import { IntegrityError } from "./integrity.js";
import { MemoryCacheStore } from "./memoryStore.js";
import {
	MAX_CONCURRENT_CHUNK_READS,
	materializeFile,
	syncIndex,
} from "./sync.js";
import type {
	CacheStore,
	IndexManifest,
	Verify,
	VersionPointer,
} from "./types.js";

const DECODER = new TextDecoder();
const PUBKEY = pubkeyRaw();
const verify: Verify = (message, signature) =>
	verifyEd25519(PUBKEY, message, signature);

const tick = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Wraps a primed store: every chunk read/probe is slow and observed. */
class ObservedStore implements CacheStore {
	public inFlightReads = 0;
	public maxInFlightReads = 0;
	public inFlightProbes = 0;
	public maxInFlightProbes = 0;
	public readsStarted = 0;
	public readonly concurrentSameChunk: string[] = [];
	readonly #open = new Set<string>();

	private readonly inner: MemoryCacheStore;
	private readonly delay: (hash: string) => number;
	private readonly poisoned: string | null;

	public constructor(
		inner: MemoryCacheStore,
		delay: (hash: string) => number = () => 2,
		poisoned: string | null = null,
	) {
		this.inner = inner;
		this.delay = delay;
		this.poisoned = poisoned;
	}

	public async hasChunk(hash: string): Promise<boolean> {
		this.inFlightProbes += 1;
		this.maxInFlightProbes = Math.max(
			this.maxInFlightProbes,
			this.inFlightProbes,
		);
		try {
			await tick(1);
			return await this.inner.hasChunk(hash);
		} finally {
			this.inFlightProbes -= 1;
		}
	}

	public async getChunk(hash: string, size: number): Promise<Uint8Array> {
		// OPFS sync access handles are exclusive per file: two concurrent reads
		// of the SAME chunk would throw NoModificationAllowedError there.
		if (this.#open.has(hash)) this.concurrentSameChunk.push(hash);
		this.#open.add(hash);
		this.readsStarted += 1;
		this.inFlightReads += 1;
		this.maxInFlightReads = Math.max(this.maxInFlightReads, this.inFlightReads);
		try {
			await tick(this.delay(hash));
			if (hash === this.poisoned) {
				throw new IntegrityError(`chunk ${hash} failed content-address check`);
			}
			return await this.inner.getChunk(hash, size);
		} finally {
			this.inFlightReads -= 1;
			this.#open.delete(hash);
		}
	}

	public putChunkCompressed(h: string, c: Uint8Array, s: number) {
		return this.inner.putChunkCompressed(h, c, s);
	}
	public putManifest(bytes: Uint8Array) {
		return this.inner.putManifest(bytes);
	}
	public getManifest(hash: string) {
		return this.inner.getManifest(hash);
	}
	public readActive() {
		return this.inner.readActive();
	}
	public promote(pointer: VersionPointer) {
		return this.inner.promote(pointer);
	}
	public clearActiveIf(pointer: VersionPointer) {
		return this.inner.clearActiveIf(pointer);
	}
	public pruneInactive() {
		return this.inner.pruneInactive();
	}
	public clear() {
		return this.inner.clear();
	}
}

// Priming decompresses and verifies the whole 728-file fixture, so it runs
// once. Every test only READS the primed store (ObservedStore never forwards a
// poisoned read, and re-promoting the same pointer is idempotent).
let primed: MemoryCacheStore;

beforeAll(async () => {
	primed = new MemoryCacheStore();
	await syncIndex({
		baseUrl: "/cat",
		store: primed,
		fetchBytes: catalogFetch().fetchBytes,
		verify,
	});
}, 60_000);

function primedStore(): MemoryCacheStore {
	return primed;
}

function pointer(): VersionPointer {
	return JSON.parse(DECODER.decode(latestBytes())) as VersionPointer;
}

async function manifestOf(store: CacheStore): Promise<IndexManifest> {
	const raw = await store.getManifest(pointer().manifest_hash);
	return JSON.parse(DECODER.decode(raw)) as IndexManifest;
}

function warmSync(store: CacheStore) {
	return syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes: catalogFetch().fetchBytes,
		verify,
	});
}

describe("warm sync re-verifies cached chunks concurrently", () => {
	it("pins the read concurrency ceiling at 8", () => {
		expect(MAX_CONCURRENT_CHUNK_READS).toBe(8);
	});

	it("saturates, but never exceeds, the bounded read concurrency", async () => {
		const store = new ObservedStore(primedStore());
		const result = await warmSync(store);
		expect(result.chunksFetched).toBe(0);
		expect(store.maxInFlightReads).toBe(8);
		expect(store.concurrentSameChunk).toEqual([]);
	});

	it("probes the cache for missing chunks concurrently, bounded", async () => {
		const store = new ObservedStore(primedStore());
		await warmSync(store);
		expect(store.maxInFlightProbes).toBe(8);
	});

	it("reassembles files in manifest order when reads finish out of order", async () => {
		const inner = primedStore();
		const manifest = await manifestOf(inner);
		const big = manifest.files.reduce((a, b) =>
			b.chunks.length > a.chunks.length ? b : a,
		);
		// Earlier chunks finish LAST: an order-losing join would mis-assemble
		// the file and fail its signed file_sha256.
		const rank = new Map(big.chunks.map((ref, index) => [ref.hash, index]));
		const store = new ObservedStore(
			inner,
			(hash) => 2 + (big.chunks.length - (rank.get(hash) ?? 0)),
		);
		const bytes = await materializeFile(store, manifest, big.path);
		expect(bytes.byteLength).toBe(big.size);
		expect(store.maxInFlightReads).toBeGreaterThan(1);
		const plain = await Promise.all(
			big.chunks.map((ref) => inner.getChunk(ref.hash, ref.size)),
		);
		// Byte-exact against the chunks joined in manifest order (Buffer.equals
		// rather than a per-element deep equality, which is slow on megabytes).
		expect(Buffer.from(bytes).equals(Buffer.concat(plain))).toBe(true);
	});

	it("one bad cached chunk fails the whole sync with that chunk's IntegrityError", async () => {
		const inner = primedStore();
		const manifest = await manifestOf(inner);
		const victim = manifest.files.at(-1)?.chunks[0]?.hash as string;
		const before = await inner.readActive();
		const store = new ObservedStore(inner, () => 2, victim);

		const failure = await warmSync(store).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(IntegrityError);
		expect((failure as Error).message).toBe(
			`chunk ${victim} failed content-address check`,
		);
		// Every started read settled before the sync rejected: no store call
		// outlives the sync (and its cache lock).
		expect(store.inFlightReads).toBe(0);
		expect(await inner.readActive()).toEqual(before);
	});

	it("stops scheduling reads once a chunk has failed", async () => {
		const inner = primedStore();
		const manifest = await manifestOf(inner);
		const victim = manifest.files[0]?.chunks[0]?.hash as string;
		const total = new Set(
			manifest.files.flatMap((file) => file.chunks.map((ref) => ref.hash)),
		).size;
		const store = new ObservedStore(inner, () => 2, victim);
		await expect(warmSync(store)).rejects.toThrow(IntegrityError);
		expect(store.readsStarted).toBeLessThan(total);
	});
});
