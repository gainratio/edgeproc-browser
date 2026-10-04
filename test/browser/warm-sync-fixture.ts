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
	boot(namespace: string, paths: ReadonlyArray<string>): Promise<BootTiming>;
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
): Promise<BootTiming> {
	const client = engine();
	try {
		const started = performance.now();
		const result = await client.sync(ORIGIN, PUBLIC_KEY, {
			cacheNamespace: namespace,
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

window.warmSync = { boot, stallSync };
