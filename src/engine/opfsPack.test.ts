// Batched OPFS chunk writes. Firefox pays ~2.5 ms (macOS) to ~10 ms (Linux)
// of storage round trips per OPFS FILE (getFileHandle + createSyncAccessHandle
// + close), so one file per ~2 KB chunk made a 783-chunk cold boot spend
// seconds in file bookkeeping. A batch lands as ONE pack file plus ONE index
// file, each written through a single sync access handle with a single flush.
// Trust is unchanged: every chunk is verified before anything lands, and every
// read re-verifies (decompress -> SHA-256 -> compare) and self-heals.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type FakeDir, FakeLocks, stubOpfs } from "./__fixtures__/fakeOpfs.js";
import { chunkBytes, signedChunkRefs } from "./fixtures.js";
import { IntegrityError } from "./integrity.js";
import { OpfsCacheStore } from "./opfsStore.js";
import { StorageQuotaError } from "./storageError.js";
import type { CompressedChunk } from "./types.js";

const REFS = [
	...new Map(signedChunkRefs().map((ref) => [ref.hash, ref])).values(),
];

function chunksOf(count: number): CompressedChunk[] {
	return REFS.slice(0, count).map((ref) => ({
		hash: ref.hash,
		compressed: chunkBytes(ref.hash),
		size: ref.size,
	}));
}

function packDir(root: FakeDir): FakeDir {
	const dir = root.dirs.get("pack");
	if (dir === undefined) throw new Error("pack directory missing");
	return dir;
}

function packIndexes(root: FakeDir): string[] {
	return [...packDir(root).files.keys()].filter((name) =>
		name.endsWith(".idx"),
	);
}

/** The single pack's data and index files (asserts there is exactly one). */
function onlyPack(root: FakeDir) {
	const [index] = packIndexes(root);
	if (index === undefined || packIndexes(root).length !== 1) {
		throw new Error("expected exactly one pack");
	}
	const data = packDir(root).files.get(index.slice(0, -".idx".length));
	const indexFile = packDir(root).files.get(index);
	if (data === undefined || indexFile === undefined) {
		throw new Error("pack files missing");
	}
	return { data, index: indexFile };
}

interface IndexShape {
	v: number;
	chunks: Array<[string, number, number]>;
}

function readIndex(root: FakeDir): IndexShape {
	return JSON.parse(
		new TextDecoder().decode(onlyPack(root).index.bytes),
	) as IndexShape;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpfsCacheStore.putChunksCompressed", () => {
	it("lands a whole batch with two files and two sync access handles", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const batch = chunksOf(REFS.length);
		const before = { ...root.stats };

		await store.putChunksCompressed(batch);

		expect(root.stats.filesCreated - before.filesCreated).toBe(2);
		expect(root.stats.syncHandles - before.syncHandles).toBe(2);
		for (const chunk of batch) {
			expect(await store.hasChunk(chunk.hash)).toBe(true);
			expect((await store.getChunk(chunk.hash, chunk.size)).byteLength).toBe(
				chunk.size,
			);
		}
		expect(root.dirs.get("chunk")?.files.size).toBe(0);
	});

	it("lands nothing when any chunk in the batch fails verification", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const batch = chunksOf(4);
		const [first, second] = batch;
		if (first === undefined || second === undefined) throw new Error("tiny");
		// Chunk 2 carries chunk 1's bytes: a valid zstd frame, wrong content.
		batch[1] = { ...second, compressed: first.compressed };

		await expect(store.putChunksCompressed(batch)).rejects.toBeInstanceOf(
			IntegrityError,
		);

		expect(packDir(root).files.size).toBe(0);
		for (const chunk of batch) {
			expect(await store.hasChunk(chunk.hash)).toBe(false);
		}
	});

	it("refuses an empty or oversized chunk before verifying anything", async () => {
		stubOpfs();
		const store = await OpfsCacheStore.open();
		const [chunk] = chunksOf(1);
		if (chunk === undefined) throw new Error("tiny");

		await expect(
			store.putChunksCompressed([{ ...chunk, compressed: new Uint8Array() }]),
		).rejects.toThrow("compressed chunk must not be empty");
		await expect(
			store.putChunksCompressed([
				{ ...chunk, compressed: new Uint8Array(2 * 1024 * 1024 + 1) },
			]),
		).rejects.toThrow("compressed chunk exceeds the OPFS read cap");
	});

	it("treats an empty batch as a no-op", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		await store.putChunksCompressed([]);
		expect(packDir(root).files.size).toBe(0);
	});

	it("removes a half-written pack and reports a typed quota error", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		root.stats.nextCreateFailure = new DOMException(
			"full",
			"QuotaExceededError",
		);

		await expect(store.putChunksCompressed(chunksOf(3))).rejects.toBeInstanceOf(
			StorageQuotaError,
		);

		expect(packDir(root).files.size).toBe(0);
		expect(await store.hasChunk(chunksOf(1)[0]?.hash ?? "")).toBe(false);
	});
});

describe("reading packed chunks", () => {
	it("refuses a chunk tampered at rest inside a pack and evicts only it", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const batch = chunksOf(3);
		await store.putChunksCompressed(batch);
		const [victim, substitute, bystander] = batch;
		if (!victim || !substitute || !bystander) throw new Error("tiny");

		// Same-origin code points the victim's slot at another valid frame.
		const pack = onlyPack(root);
		const index = readIndex(root);
		const offset = pack.data.bytes.byteLength;
		const grown = new Uint8Array(offset + substitute.compressed.byteLength);
		grown.set(pack.data.bytes);
		grown.set(substitute.compressed, offset);
		pack.data.bytes = grown;
		index.chunks = index.chunks.map((entry) =>
			entry[0] === victim.hash
				? [victim.hash, offset, substitute.compressed.byteLength]
				: entry,
		);
		pack.index.bytes = new TextEncoder().encode(JSON.stringify(index));

		const reopened = await OpfsCacheStore.open();
		await expect(
			reopened.getChunk(victim.hash, victim.size),
		).rejects.toBeInstanceOf(IntegrityError);
		expect(await reopened.hasChunk(victim.hash)).toBe(false);
		expect(await reopened.hasChunk(bystander.hash)).toBe(true);
		expect(
			(await reopened.getChunk(bystander.hash, bystander.size)).byteLength,
		).toBe(bystander.size);

		// The eviction is durable: a fresh store does not see the victim either.
		const third = await OpfsCacheStore.open();
		expect(await third.hasChunk(victim.hash)).toBe(false);
		expect(await third.hasChunk(bystander.hash)).toBe(true);
	});

	it("deletes a pack whose last chunk is evicted", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const [only] = chunksOf(1);
		if (only === undefined) throw new Error("tiny");
		await store.putChunksCompressed([only]);
		const data = onlyPack(root).data;
		data.bytes[0] = (data.bytes[0] ?? 0) ^ 0xff;

		await expect(store.getChunk(only.hash, only.size)).rejects.toBeInstanceOf(
			IntegrityError,
		);
		expect(packDir(root).files.size).toBe(0);
	});

	it("ignores and removes a torn index or one that points past its data", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const batch = chunksOf(2);
		await store.putChunksCompressed(batch);
		const pack = onlyPack(root);
		pack.data.bytes = pack.data.bytes.slice(0, 10);

		const reopened = await OpfsCacheStore.open();
		for (const chunk of batch) {
			expect(await reopened.hasChunk(chunk.hash)).toBe(false);
		}
		expect(packDir(root).files.size).toBe(0);

		await reopened.putChunksCompressed(batch);
		onlyPack(root).index.bytes = new TextEncoder().encode('{"v":1,"chu');
		const third = await OpfsCacheStore.open();
		expect(await third.hasChunk(batch[0]?.hash ?? "")).toBe(false);
		expect(packDir(root).files.size).toBe(0);
	});

	it("drops an index whose data file is missing", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const [chunk] = chunksOf(1);
		if (chunk === undefined) throw new Error("tiny");
		await store.putChunksCompressed([chunk]);
		const [index] = packIndexes(root);
		packDir(root).files.delete(index?.slice(0, -".idx".length) ?? "");

		const reopened = await OpfsCacheStore.open();
		expect(await reopened.hasChunk(chunk.hash)).toBe(false);
		expect(packDir(root).files.size).toBe(0);
	});

	it.each([
		["wrong version", { v: 2, chunks: [] }],
		["not a list", { v: 1, chunks: {} }],
		["bad hash", { v: 1, chunks: [["XYZ", 0, 1]] }],
		["negative offset", { v: 1, chunks: [["a".repeat(64), -1, 1]] }],
		["empty slice", { v: 1, chunks: [["a".repeat(64), 0, 0]] }],
		["oversized slice", { v: 1, chunks: [["a".repeat(64), 0, 2 ** 21 + 1]] }],
		["short entry", { v: 1, chunks: [["a".repeat(64), 0]] }],
	])("rejects an index with %s", async (_label, forged) => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		await store.putChunksCompressed(chunksOf(1));
		onlyPack(root).index.bytes = new TextEncoder().encode(
			JSON.stringify(forged),
		);

		const reopened = await OpfsCacheStore.open();
		expect(await reopened.hasChunk("a".repeat(64))).toBe(false);
		expect(packDir(root).files.size).toBe(0);
	});

	it("still reads chunks stored one-file-per-chunk by older releases", async () => {
		stubOpfs();
		const store = await OpfsCacheStore.open();
		const [legacy, packed] = chunksOf(2);
		if (legacy === undefined || packed === undefined) throw new Error("tiny");
		await store.putChunkCompressed(legacy.hash, legacy.compressed, legacy.size);
		await store.putChunksCompressed([packed]);

		const reopened = await OpfsCacheStore.open();
		expect(await reopened.hasChunk(legacy.hash)).toBe(true);
		expect((await reopened.getChunk(legacy.hash, legacy.size)).byteLength).toBe(
			legacy.size,
		);
		expect((await reopened.getChunk(packed.hash, packed.size)).byteLength).toBe(
			packed.size,
		);
	});

	it("re-reads a pack whose cached snapshot went stale", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const [chunk] = chunksOf(1);
		if (chunk === undefined) throw new Error("tiny");
		await store.putChunksCompressed([chunk]);
		const data = onlyPack(root).data;
		const getFile = data.getFile.bind(data);
		let calls = 0;
		data.getFile = () => {
			calls += 1;
			return calls === 1
				? Promise.resolve({
						size: data.bytes.byteLength,
						slice: () => ({
							arrayBuffer: () =>
								Promise.reject(new DOMException("stale", "NotReadableError")),
						}),
					} as unknown as Blob)
				: getFile();
		};

		const reopened = await OpfsCacheStore.open();
		expect((await reopened.getChunk(chunk.hash, chunk.size)).byteLength).toBe(
			chunk.size,
		);
	});
});

describe("pruning and clearing packs", () => {
	it("drops dead packs, compacts mostly-dead ones and keeps live chunks", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const live = chunksOf(6);
		const [keep, ...dead] = live;
		if (keep === undefined) throw new Error("tiny");
		await store.putChunksCompressed(live);
		await store.putChunksCompressed(chunksOf(8).slice(6));
		const manifest = new TextEncoder().encode(
			JSON.stringify({ files: [{ chunks: [{ hash: keep.hash }] }] }),
		);
		const manifestHash = await store.putManifest(manifest);
		await store.promote({
			manifest_hash: manifestHash,
			version: "v1",
			bundle_id: null,
			channel: null,
			sequence: 1,
			signature: "s",
		});

		await store.pruneInactive();

		expect(packIndexes(root)).toHaveLength(1);
		expect(await store.hasChunk(keep.hash)).toBe(true);
		expect((await store.getChunk(keep.hash, keep.size)).byteLength).toBe(
			keep.size,
		);
		for (const chunk of dead)
			expect(await store.hasChunk(chunk.hash)).toBe(false);
		expect(onlyPack(root).data.bytes.byteLength).toBe(
			keep.compressed.byteLength,
		);
		const reopened = await OpfsCacheStore.open();
		expect(await reopened.hasChunk(keep.hash)).toBe(true);
		expect(await reopened.hasChunk(dead[0]?.hash ?? "")).toBe(false);
	});

	it("keeps a mostly-live pack in place and drops only its dead entries", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const batch = chunksOf(4);
		await store.putChunksCompressed(batch);
		const before = onlyPack(root).data.bytes.byteLength;
		const kept = batch.slice(0, 3);
		const manifestHash = await store.putManifest(
			new TextEncoder().encode(
				JSON.stringify({
					files: [{ chunks: kept.map((chunk) => ({ hash: chunk.hash })) }],
				}),
			),
		);
		await store.promote({
			manifest_hash: manifestHash,
			version: "v1",
			bundle_id: null,
			channel: null,
			sequence: 1,
			signature: "s",
		});

		await store.pruneInactive();

		expect(onlyPack(root).data.bytes.byteLength).toBe(before);
		expect(readIndex(root).chunks.map(([hash]) => hash)).toEqual(
			kept.map((chunk) => chunk.hash),
		);
	});

	it("prune removes pack data whose index never landed", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const [chunk] = chunksOf(1);
		if (chunk === undefined) throw new Error("tiny");
		await store.putChunksCompressed([chunk]);
		const manifestHash = await store.putManifest(
			new TextEncoder().encode(
				JSON.stringify({ files: [{ chunks: [{ hash: chunk.hash }] }] }),
			),
		);
		await store.promote({
			manifest_hash: manifestHash,
			version: "v1",
			bundle_id: null,
			channel: null,
			sequence: 1,
			signature: "s",
		});
		await packDir(root).getFileHandle("orphan", { create: true });

		await store.pruneInactive();

		expect(packDir(root).files.has("orphan")).toBe(false);
		expect(packIndexes(root)).toHaveLength(1);
		expect(await store.hasChunk(chunk.hash)).toBe(true);
	});

	it("clear removes every pack", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const batch = chunksOf(3);
		await store.putChunksCompressed(batch);
		await store.clear();
		expect(packDir(root).files.size).toBe(0);
		for (const chunk of batch) {
			expect(await store.hasChunk(chunk.hash)).toBe(false);
		}
	});
});

async function promoteChunks(
	store: OpfsCacheStore,
	chunks: ReadonlyArray<CompressedChunk>,
	sequence = 1,
): Promise<void> {
	const manifestHash = await store.putManifest(
		new TextEncoder().encode(
			JSON.stringify({
				files: [{ chunks: chunks.map((chunk) => ({ hash: chunk.hash })) }],
			}),
		),
	);
	await store.promote({
		manifest_hash: manifestHash,
		version: `v${sequence}`,
		bundle_id: null,
		channel: null,
		sequence,
		signature: "s",
	});
}

describe("packs written by another tab", () => {
	it("are found by a store that scanned before they existed", async () => {
		stubOpfs();
		const early = await OpfsCacheStore.open();
		const batch = chunksOf(3);
		expect(await early.hasChunk(batch[0]?.hash ?? "")).toBe(false);

		const other = await OpfsCacheStore.open();
		await other.putChunksCompressed(batch);

		for (const chunk of batch) {
			expect(await early.hasChunk(chunk.hash)).toBe(true);
			expect((await early.getChunk(chunk.hash, chunk.size)).byteLength).toBe(
				chunk.size,
			);
		}
	});

	it("are not deleted when a stale store prunes", async () => {
		const root = stubOpfs();
		const stale = await OpfsCacheStore.open();
		await stale.hasChunk("a".repeat(64));
		const batch = chunksOf(3);
		const other = await OpfsCacheStore.open();
		await other.putChunksCompressed(batch);
		await promoteChunks(other, batch);

		await stale.pruneInactive();

		expect(packIndexes(root)).toHaveLength(1);
		const fresh = await OpfsCacheStore.open();
		for (const chunk of batch) {
			expect(await fresh.hasChunk(chunk.hash)).toBe(true);
		}
	});

	it("are forgotten when another tab removed them", async () => {
		stubOpfs();
		const reader = await OpfsCacheStore.open();
		const batch = chunksOf(2);
		await reader.putChunksCompressed(batch);
		const other = await OpfsCacheStore.open();
		await other.clear();
		// Any miss rescans; the rescan forgets packs whose index is gone.
		await reader.hasChunk("c".repeat(64));

		expect(await reader.hasChunk(batch[1]?.hash ?? "")).toBe(false);
		await expect(
			reader.getChunk(batch[0]?.hash ?? "", batch[0]?.size ?? 0),
		).rejects.toThrow();
	});

	it("are pruned by a stale store when they are no longer live", async () => {
		const root = stubOpfs();
		const stale = await OpfsCacheStore.open();
		await stale.hasChunk("a".repeat(64));
		const other = await OpfsCacheStore.open();
		const [dead, live] = [chunksOf(2), chunksOf(4).slice(2)];
		await other.putChunksCompressed(dead);
		await other.putChunksCompressed(live);
		await promoteChunks(other, live);

		await stale.pruneInactive();

		expect(packIndexes(root)).toHaveLength(1);
		const fresh = await OpfsCacheStore.open();
		expect(await fresh.hasChunk(dead[0]?.hash ?? "")).toBe(false);
		expect(await fresh.hasChunk(live[0]?.hash ?? "")).toBe(true);
	});

	it("leave an in-flight write alone until no writer holds the pack lock", async () => {
		const locks = new FakeLocks();
		const root = stubOpfs(locks);
		const store = await OpfsCacheStore.open();
		const [chunk] = chunksOf(1);
		if (chunk === undefined) throw new Error("tiny");
		await store.putChunksCompressed([chunk]);
		await promoteChunks(store, [chunk]);
		// Another tab is mid-write: its data file exists, its index does not yet.
		const release = locks.hold("edgeproc-opfs-packs", "shared");
		await packDir(root).getFileHandle("in-flight", { create: true });
		await packDir(root).getFileHandle("torn.idx", { create: true });

		await store.pruneInactive();
		await OpfsCacheStore.open().then((other) => other.hasChunk("b".repeat(64)));
		expect(packDir(root).files.has("in-flight")).toBe(true);
		expect(packDir(root).files.has("torn.idx")).toBe(true);

		release();
		await store.pruneInactive();
		expect(packDir(root).files.has("in-flight")).toBe(false);
		expect(packDir(root).files.has("torn.idx")).toBe(false);
		expect(await store.hasChunk(chunk.hash)).toBe(true);
	});

	it("never deletes unindexed files in a browser without Web Locks", async () => {
		const root = stubOpfs(null);
		const store = await OpfsCacheStore.open();
		const [chunk] = chunksOf(1);
		if (chunk === undefined) throw new Error("tiny");
		await store.putChunksCompressed([chunk]);
		await promoteChunks(store, [chunk]);
		await packDir(root).getFileHandle("in-flight", { create: true });

		await store.pruneInactive();

		expect(packDir(root).files.has("in-flight")).toBe(true);
		expect(await store.hasChunk(chunk.hash)).toBe(true);
	});
});

describe("pack write ordering", () => {
	it("flushes the data file before its index", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		await store.putChunksCompressed(chunksOf(2));
		const [index] = packIndexes(root);
		const pack = index?.slice(0, -".idx".length);
		expect(root.stats.flushes).toEqual([pack, index]);
	});

	it("removes the data file when the index cannot be written", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		root.stats.failCreate = (name) =>
			name.endsWith(".idx")
				? new DOMException("full", "QuotaExceededError")
				: undefined;

		await expect(store.putChunksCompressed(chunksOf(2))).rejects.toBeInstanceOf(
			StorageQuotaError,
		);
		expect(packDir(root).files.size).toBe(0);
	});

	it("does not leave an orphan index when evicting from a pack whose data is gone", async () => {
		const root = stubOpfs();
		const store = await OpfsCacheStore.open();
		const batch = chunksOf(2);
		await store.putChunksCompressed(batch);
		const [index] = packIndexes(root);
		packDir(root).files.delete(index?.slice(0, -".idx".length) ?? "");

		await expect(
			store.getChunk(batch[0]?.hash ?? "", batch[0]?.size ?? 0),
		).rejects.toThrow();
		expect(packDir(root).files.size).toBe(0);
	});
});
