// Real-Chromium warm-boot harness: the BUILT engine Worker (dist/) syncing a
// signed bundle into real OPFS. A "reload" is modelled as disposing the Worker
// and starting a fresh one on the same origin storage, which is what a page
// reload does to the engine.

import { EngineClient, EngineOperationError } from "@edgeproc/browser";

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

/** Same-origin code rewrites one cached chunk at rest, exactly as an XSS or a
 * compromised dependency on the page could. */
async function overwriteChunk(chunkHash: string, bytes: Uint8Array) {
	const root = await navigator.storage.getDirectory();
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

window.warmSync = { boot, tamper };
