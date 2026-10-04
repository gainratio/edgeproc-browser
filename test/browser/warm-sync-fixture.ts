// Real-Chromium warm-boot harness: the BUILT engine Worker (dist/) syncing a
// signed bundle into real OPFS. A "reload" is modelled as disposing the Worker
// and starting a fresh one on the same origin storage, which is what a page
// reload does to the engine.

import {
	EngineClient,
	EngineOperationError,
	type SyncProgress,
} from "@gainratio/browser";

export interface BootTiming {
	readonly syncMs: number;
	readonly readMs: number;
	readonly chunksFetched: number;
	readonly chunksReused: number;
}

export interface TamperOutcome {
	readonly tamperedSyncCode: string;
	readonly tamperedReadCode: string;
	readonly healedChunksFetched: number;
	readonly healedBytesMatch: boolean;
}

export interface RetryNotice {
	readonly hash: string;
	readonly attempt: number;
	readonly reason: string;
}

/** What one sync under a network stall looked like from the main thread. */
export interface StallOutcome {
	/** "ok" or the error's name/code (e.g. WorkerTimeoutError). */
	readonly outcome: string;
	readonly chunksFetched: number;
	readonly elapsedMs: number;
	readonly retries: ReadonlyArray<RetryNotice>;
	/** Longest silence between two progress events, as the client saw it. */
	readonly longestGapMs: number;
	readonly bytesTotal: number;
	readonly bytesDone: number;
	readonly verifyEvents: number;
}

interface WarmSyncHarness {
	boot(
		namespace: string,
		paths: ReadonlyArray<string>,
		backend: "auto" | "indexeddb",
	): Promise<BootTiming>;
	tamper(
		namespace: string,
		path: string,
		chunkHash: string,
		forgedHex: string,
	): Promise<TamperOutcome>;
	stallSync(namespace: string): Promise<StallOutcome>;
}

declare global {
	interface Window {
		warmSync: WarmSyncHarness;
	}
}

// Served from disk by the spec's route handler.
const ORIGIN = "/bundle-origin";
const PUBLIC_KEY = "/bundle-origin/public.key";

function engine(): EngineClient {
	return new EngineClient(
		new Worker(new URL("/dist/engine/worker.js", location.href), {
			type: "module",
		}),
		{ idleTimeoutMs: 120_000 },
	);
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(
		(text.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)),
	);
}

async function readAll(
	client: EngineClient,
	paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<Uint8Array>> {
	return Promise.all(paths.map((path) => client.readFile(path)));
}

/** One boot: a fresh Worker syncs, then the app reads every file. */
async function boot(
	namespace: string,
	paths: ReadonlyArray<string>,
	backend: "auto" | "indexeddb",
): Promise<BootTiming> {
	const client = engine();
	try {
		const started = performance.now();
		const result = await client.sync(ORIGIN, PUBLIC_KEY, {
			cacheNamespace: namespace,
			storageBackend: backend,
		});
		const synced = performance.now();
		await readAll(client, paths);
		return {
			syncMs: synced - started,
			readMs: performance.now() - synced,
			chunksFetched: result.chunksFetched,
			chunksReused: result.chunksReused,
		};
	} finally {
		client.dispose();
	}
}

function codeOf(error: unknown): string {
	return error instanceof EngineOperationError ? error.code : String(error);
}

async function writeAt(
	file: FileSystemFileHandle,
	position: number,
	data: Uint8Array | string,
	keepExistingData: boolean,
): Promise<void> {
	const writable = await file.createWritable({ keepExistingData });
	await writable.write({
		type: "write",
		position,
		data: data as Uint8Array<ArrayBuffer> | string,
	});
	await writable.close();
}

/** Redirect the chunk's slot in its pack index to `bytes`, appended to the
 * pack's data file. False when no pack holds the chunk. */
async function overwritePacked(
	root: FileSystemDirectoryHandle,
	chunkHash: string,
	bytes: Uint8Array,
): Promise<boolean> {
	const packs = await root.getDirectoryHandle("pack", { create: true });
	for await (const [name, handle] of packs.entries()) {
		if (!name.endsWith(".idx") || handle.kind !== "file") continue;
		const index = JSON.parse(await (await handle.getFile()).text()) as {
			chunks: Array<[string, number, number]>;
		};
		const at = index.chunks.findIndex(([hash]) => hash === chunkHash);
		if (at < 0) continue;
		const data = await packs.getFileHandle(name.slice(0, -".idx".length));
		const end = (await data.getFile()).size;
		await writeAt(data, end, bytes, true);
		index.chunks[at] = [chunkHash, end, bytes.byteLength];
		await writeAt(handle, 0, JSON.stringify(index), false);
		return true;
	}
	return false;
}

/** Same-origin code rewrites one cached chunk at rest, exactly as an XSS or a
 * compromised dependency on the page could: inside its pack when one holds
 * it, else at the one-file-per-chunk location. */
async function overwriteChunk(chunkHash: string, bytes: Uint8Array) {
	const root = await navigator.storage.getDirectory();
	if (await overwritePacked(root, chunkHash, bytes)) return;
	const chunks = await root.getDirectoryHandle("chunk");
	const file = await chunks.getFileHandle(chunkHash, { create: true });
	const writable = await file.createWritable();
	await writable.write(bytes as Uint8Array<ArrayBuffer>);
	await writable.close();
}

async function attempt(operation: () => Promise<unknown>): Promise<string> {
	try {
		await operation();
		return "accepted";
	} catch (error) {
		return codeOf(error);
	}
}

async function tamper(
	namespace: string,
	path: string,
	chunkHash: string,
	forgedHex: string,
): Promise<TamperOutcome> {
	const primer = engine();
	await primer.sync(ORIGIN, PUBLIC_KEY, { cacheNamespace: namespace });
	const original = await primer.readFile(path);
	primer.dispose();

	await overwriteChunk(chunkHash, fromHex(forgedHex));

	// The read happens first, against the still-promoted release: the app must
	// not be handed the forged bytes even without a fresh sync.
	const reader = engine();
	await reader.sync(ORIGIN, PUBLIC_KEY, {
		cacheNamespace: namespace,
		wantedPaths: [],
	});
	const tamperedReadCode = await attempt(() => reader.readFile(path));
	reader.dispose();

	await overwriteChunk(chunkHash, fromHex(forgedHex));
	const victim = engine();
	const tamperedSyncCode = await attempt(() =>
		victim.sync(ORIGIN, PUBLIC_KEY, { cacheNamespace: namespace }),
	);
	victim.dispose();

	const healer = engine();
	const healed = await healer.sync(ORIGIN, PUBLIC_KEY, {
		cacheNamespace: namespace,
	});
	const bytes = await healer.readFile(path);
	healer.dispose();
	return {
		tamperedSyncCode,
		tamperedReadCode,
		healedChunksFetched: healed.chunksFetched,
		healedBytesMatch:
			bytes.byteLength === original.byteLength &&
			bytes.every((value, index) => value === original[index]),
	};
}

/**
 * One cold sync with the client's DEFAULT idle deadline (the one real apps
 * run with), while the spec's route handler holds chunk requests for longer
 * than that deadline. Records every retry notice and the longest silence.
 */
async function stallSync(namespace: string): Promise<StallOutcome> {
	const client = new EngineClient(
		new Worker(new URL("/dist/engine/worker.js", location.href), {
			type: "module",
		}),
	);
	const retries: RetryNotice[] = [];
	let lastEvent = performance.now();
	let longestGapMs = 0;
	let bytesTotal = 0;
	let bytesDone = 0;
	let verifyEvents = 0;
	const onProgress = (progress: SyncProgress): void => {
		const now = performance.now();
		longestGapMs = Math.max(longestGapMs, now - lastEvent);
		lastEvent = now;
		if (progress.phase === "chunkRetry") {
			retries.push({
				hash: progress.hash,
				attempt: progress.attempt,
				reason: progress.reason,
			});
		} else if (progress.phase === "chunks") {
			bytesTotal = progress.bytesTotal;
			bytesDone = progress.bytesDone;
		} else if (progress.phase === "verify") {
			verifyEvents += 1;
		}
	};
	const started = performance.now();
	let outcome = "ok";
	let chunksFetched = 0;
	try {
		const result = await client.sync(ORIGIN, PUBLIC_KEY, {
			cacheNamespace: namespace,
			onProgress,
		});
		chunksFetched = result.chunksFetched;
	} catch (error) {
		outcome =
			error instanceof EngineOperationError
				? error.code
				: error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error);
	} finally {
		client.dispose();
	}
	return {
		outcome,
		chunksFetched,
		elapsedMs: performance.now() - started,
		retries,
		longestGapMs,
		bytesTotal,
		bytesDone,
		verifyEvents,
	};
}

window.warmSync = { boot, tamper, stallSync };
