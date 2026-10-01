// Progress-aware sync: what the Worker reports while bytes are still arriving,
// when a chunk fetch stalls and is retried, and what survives a failed sync.
//
// Why this exists: the client's idle deadline is re-armed by progress events,
// and progress used to be reported only when a whole chunk had been fetched,
// verified and stored. On a slow mobile link that gap grew past the deadline,
// the Worker was killed mid-sync, and the app never started. Progress now
// moves on every network read, and a stalled fetch is announced (and retried)
// instead of being silently absorbed.

import { Zstd } from "@hpcc-js/wasm-zstd";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { MemoryCacheStore } from "./memoryStore.js";
import { type SyncProgress, syncIndex } from "./sync.js";
import type {
	FetchBytes,
	FetchBytesOptions,
	IndexManifest,
	Verify,
	VersionPointer,
} from "./types.js";

const ENCODER = new TextEncoder();
const passVerify: Verify = () => Promise.resolve();
const STALLED = "fetch /o/chunk/x failed: stalled: no bytes for 30000ms";

interface Chunk {
	readonly hash: string;
	readonly plain: Uint8Array;
	readonly compressed: Uint8Array;
}

interface Origin {
	readonly a: Chunk;
	readonly b: Chunk;
	readonly bytesTotal: number;
	/** Healthy transport: every URL resolves, chunk fetches report bytes. */
	readonly fetchBytes: FetchBytes;
	/** Chunk hashes requested through `fetchBytes` so far. */
	readonly chunkRequests: string[];
}

async function chunkOf(text: string, zstd: Zstd): Promise<Chunk> {
	const plain = ENCODER.encode(text);
	return {
		hash: await sha256Hex(plain),
		plain,
		compressed: zstd.compress(plain),
	};
}

/** Two one-chunk files, so a sync has two independent chunk fetches. */
async function origin(): Promise<Origin> {
	const zstd = await Zstd.load();
	const a = await chunkOf("file a: ".padEnd(300, "a"), zstd);
	const b = await chunkOf("file b: ".padEnd(500, "b"), zstd);
	const file = (path: string, chunk: Chunk) => ({
		path,
		file_type: null,
		size: chunk.plain.byteLength,
		file_sha256: chunk.hash,
		chunks: [{ hash: chunk.hash, size: chunk.plain.byteLength }],
	});
	const manifest: IndexManifest = {
		schema_version: 2,
		bundle_id: "progress-test",
		version: "v1",
		files: [file("a.bin", a), file("b.bin", b)],
		metadata: {},
	};
	const manifestBytes = ENCODER.encode(JSON.stringify(manifest));
	const pointer: VersionPointer = {
		manifest_hash: await sha256Hex(manifestBytes),
		version: "v1",
		bundle_id: "progress-test",
		channel: "stable",
		sequence: 1,
		signature: "test-signature",
	};
	const chunkRequests: string[] = [];
	const fetchBytes: FetchBytes = (url, options) => {
		if (url.endsWith("/latest")) {
			return Promise.resolve(ENCODER.encode(JSON.stringify(pointer)));
		}
		if (url.endsWith(`/manifest/${pointer.manifest_hash}`)) {
			return Promise.resolve(manifestBytes);
		}
		const hash = url.split("/").at(-1) ?? "";
		const chunk = [a, b].find((candidate) => candidate.hash === hash);
		if (chunk === undefined) {
			return Promise.reject(new Error(`unexpected ${url}`));
		}
		chunkRequests.push(hash);
		return streamed(chunk, options);
	};
	return {
		a,
		b,
		bytesTotal: a.plain.byteLength + b.plain.byteLength,
		fetchBytes,
		chunkRequests,
	};
}

/** A chunk arriving in two network reads, reported through `onBytes`. */
async function streamed(
	chunk: Chunk,
	options?: FetchBytesOptions,
): Promise<Uint8Array> {
	const total = chunk.compressed.byteLength;
	options?.onBytes?.(Math.floor(total / 2), total);
	await Promise.resolve();
	options?.onBytes?.(total, total);
	return chunk.compressed;
}

type Chunks = Extract<SyncProgress, { phase: "chunks" }>;
type Retry = Extract<SyncProgress, { phase: "chunkRetry" }>;

describe("byte-level sync progress", () => {
	it("moves while a chunk is still arriving, and reaches the exact total", async () => {
		const site = await origin();
		const events: SyncProgress[] = [];
		const result = await syncIndex({
			baseUrl: "/o",
			store: new MemoryCacheStore(),
			verify: passVerify,
			fetchBytes: site.fetchBytes,
			onProgress: (event) => events.push(event),
		});

		expect(result.chunksFetched).toBe(2);
		const chunks = events.filter((e): e is Chunks => e.phase === "chunks");
		// Something was reported BEFORE any chunk completed: partial bytes.
		const partial = chunks.find((e) => e.fetchedChunks === 0);
		expect(partial).toBeDefined();
		expect(partial?.bytesDone).toBeGreaterThan(0);
		expect(partial?.bytesDone).toBeLessThan(site.bytesTotal);
		// The total is the signed manifest's plain size of everything to fetch.
		for (const event of chunks) expect(event.bytesTotal).toBe(site.bytesTotal);
		expect(chunks.at(-1)).toMatchObject({
			fetchedChunks: 2,
			totalChunks: 2,
			bytesDone: site.bytesTotal,
			bytesFetched: result.bytesFetched,
		});
	});

	it("announces each retry of a stalled chunk fetch, then completes", async () => {
		const site = await origin();
		let bAttempts = 0;
		const events: SyncProgress[] = [];
		const result = await syncIndex({
			baseUrl: "/o",
			store: new MemoryCacheStore(),
			verify: passVerify,
			fetchBytes: (url, options) => {
				if (url.endsWith(`/chunk/${site.b.hash}`) && bAttempts++ === 0) {
					return Promise.reject(new NetworkError(STALLED));
				}
				return site.fetchBytes(url, options);
			},
			sleep: () => Promise.resolve(),
			onProgress: (event) => events.push(event),
		});

		expect(result.chunksFetched).toBe(2);
		const retries = events.filter((e): e is Retry => e.phase === "chunkRetry");
		expect(retries).toHaveLength(1);
		expect(retries[0]).toMatchObject({
			hash: site.b.hash,
			attempt: 1,
			maxAttempts: 6,
		});
		expect(retries[0]?.delayMs).toBeGreaterThanOrEqual(250);
		expect(retries[0]?.reason).toMatch(/stalled/u);
	});

	it("keeps verified chunks across a failed sync; the retry fetches only what is missing", async () => {
		const site = await origin();
		const store = new MemoryCacheStore();
		const dead: FetchBytes = (url, options) =>
			url.endsWith(`/chunk/${site.b.hash}`)
				? Promise.reject(new NetworkError(STALLED))
				: site.fetchBytes(url, options);

		await expect(
			syncIndex({
				baseUrl: "/o",
				store,
				verify: passVerify,
				fetchBytes: dead,
				sleep: () => Promise.resolve(),
			}),
		).rejects.toBeInstanceOf(NetworkError);
		expect(await store.readActive()).toBeNull(); // nothing promoted
		const before = site.chunkRequests.length;

		const result = await syncIndex({
			baseUrl: "/o",
			store,
			verify: passVerify,
			fetchBytes: site.fetchBytes,
		});

		expect(result).toMatchObject({ chunksFetched: 1, chunksReused: 1 });
		expect(site.chunkRequests.slice(before)).toEqual([site.b.hash]);
	});

	it("reports a verify phase per file once every chunk is in", async () => {
		const site = await origin();
		const events: SyncProgress[] = [];
		await syncIndex({
			baseUrl: "/o",
			store: new MemoryCacheStore(),
			verify: passVerify,
			fetchBytes: site.fetchBytes,
			onProgress: (event) => events.push(event),
		});

		const phases = events.map((e) => e.phase);
		expect(phases.lastIndexOf("chunks")).toBeLessThan(phases.indexOf("verify"));
		expect(phases.lastIndexOf("verify")).toBeLessThan(
			phases.indexOf("promoted"),
		);
		expect(events.filter((e) => e.phase === "verify")).toEqual([
			{ phase: "verify", verifiedFiles: 1, totalFiles: 2 },
			{ phase: "verify", verifiedFiles: 2, totalFiles: 2 },
		]);
	});
});
