// Thin main-thread client over the Worker engine. The main thread cannot touch
// OPFS sync access handles (SQLite's opfs-sahpool needs them), so it only sends typed requests and awaits replies.
// One in-flight map keyed by request id correlates responses to promises.
//
// Failure semantics: a Worker that crashes before replying (init throw, script
// load failure) fires 'error'/'messageerror' but never posts a reply — so every
// in-flight request is rejected with a typed WorkerCrashError (and the client
// latches, failing subsequent requests fast). A silent Worker is bounded by a
// per-request response deadline that rejects with WorkerTimeoutError.
//
// EVERY failure path also TERMINATES the Worker, and that is the load-bearing
// half. An 'error' event is an uncaught throw inside the Worker, not proof the
// Worker died; a deadline expiring says nothing about the Worker at all. Left
// running, either one can keep the SQLite pool's OPFS handles and owner lock,
// so the next EngineClient cannot open the store — while no caller will ever
// read from it again. Settling the promises without releasing the thread just
// trades a hung caller for a leaked one.

import { engineErrorOf } from "./engineError.js";
import type { IndexedDbLayoutOptions } from "./legacyStores.js";
import type {
	EngineCacheFallback,
	EngineRequest,
	EngineResponse,
} from "./protocol.js";
import type { SyncProgress } from "./sync.js";
import type { EngineSyncResult } from "./types.js";
import {
	DEFAULT_REQUEST_TIMEOUT_MS,
	WorkerCrashError,
	WorkerTimeoutError,
} from "./workerFault.js";

/** The minimal Worker surface this client needs — small so tests can fake it. */
export interface EngineWorkerLike {
	postMessage(message: EngineRequest): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<EngineResponse>) => void,
	): void;
	addEventListener(
		type: "error",
		listener: (event: { message: string }) => void,
	): void;
	addEventListener(type: "messageerror", listener: () => void): void;
	terminate(): void;
}

/** Tuning knobs for the client (defaults suit the engine's sync/readFile calls). */
export interface EngineClientOptions {
	/** Idle deadline. Every authenticated sync progress event re-arms it. */
	readonly idleTimeoutMs?: number;
	/** @deprecated Use idleTimeoutMs. Retained for source compatibility. */
	readonly requestTimeoutMs?: number;
}

export interface EngineSyncOptions {
	/** undefined skips the identity check; null requires absent/null. */
	readonly expectedBundleId?: string | null;
	/** undefined skips the identity check; null requires absent/null. */
	readonly expectedChannel?: string | null;
	/** undefined fetches all files; [] authenticates/promotes only the catalog. */
	readonly wantedPaths?: ReadonlyArray<string>;
	/** Names this cache: its SQLite database and its cross-tab lock. */
	readonly cacheNamespace?: string;
	/** Where a 0.2.x cache kept its IndexedDB rollback floor. Read once to
	 * migrate into SQLite (the floor is never lowered), then deleted. */
	readonly indexedDbLayout?: IndexedDbLayoutOptions;
	/** When OPFS cannot be opened. "memory" (default): cache in RAM for this
	 * Worker's life and re-download each session. "none": download nothing and
	 * reject with EngineStorageUnavailableError. Fixed by the Worker's first use. */
	readonly cacheFallback?: EngineCacheFallback;
	readonly onProgress?: (progress: SyncProgress) => void;
}

export type EngineStorageOptions = Pick<
	EngineSyncOptions,
	"cacheNamespace" | "indexedDbLayout" | "cacheFallback"
>;

interface Pending {
	readonly resolve: (response: EngineResponse) => void;
	readonly reject: (error: Error) => void;
	readonly request: EngineRequest;
	readonly onProgress?: (progress: SyncProgress) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export class EngineClient {
	readonly #worker: EngineWorkerLike;
	readonly #pending = new Map<number, Pending>();
	readonly #timeoutMs: number;
	#nextId = 0;
	#crash: WorkerCrashError | undefined;
	#disposed = false;
	#released = false;

	public constructor(
		worker: EngineWorkerLike,
		options: EngineClientOptions = {},
	) {
		this.#worker = worker;
		this.#timeoutMs =
			options.idleTimeoutMs ??
			options.requestTimeoutMs ??
			DEFAULT_REQUEST_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
			throw new TypeError("idle timeout must be a positive safe integer");
		}
		this.#worker.addEventListener("message", (event) => {
			this.#onMessage(event.data);
		});
		this.#worker.addEventListener("error", (event) => {
			this.#onCrash(event.message);
		});
		this.#worker.addEventListener("messageerror", () => {
			this.#onCrash("a worker reply was not deserializable (messageerror)");
		});
	}

	/** Sync the signed bundle at `baseUrl`, pinning the trust root at
	 * `pubkeyUrl`: a raw 32-byte Ed25519 key, or an `edgeproc.keyring/v1` JSON
	 * keyring (key rotation + revocation). */
	public sync(
		baseUrl: string,
		pubkeyUrl: string,
		options?: EngineSyncOptions,
	): Promise<EngineSyncResult>;
	public sync(
		baseUrl: string,
		pubkeyUrl: string,
		expectedBundleId?: string | null,
		expectedChannel?: string | null,
		options?: Omit<EngineSyncOptions, "expectedBundleId" | "expectedChannel">,
	): Promise<EngineSyncResult>;
	public async sync(
		baseUrl: string,
		pubkeyUrl: string,
		identityOrOptions?: string | null | EngineSyncOptions,
		expectedChannel?: string | null,
		controls: Omit<
			EngineSyncOptions,
			"expectedBundleId" | "expectedChannel"
		> = {},
	): Promise<EngineSyncResult> {
		const options =
			typeof identityOrOptions === "object" && identityOrOptions !== null
				? identityOrOptions
				: {
						...controls,
						...(identityOrOptions !== undefined
							? { expectedBundleId: identityOrOptions }
							: {}),
						...(expectedChannel !== undefined ? { expectedChannel } : {}),
					};
		const response = await this.#send(
			{
				kind: "sync",
				id: this.#allocId(),
				baseUrl,
				pubkeyUrl,
				...(options.expectedBundleId !== undefined
					? { expectedBundleId: options.expectedBundleId }
					: {}),
				...(options.expectedChannel !== undefined
					? { expectedChannel: options.expectedChannel }
					: {}),
				...(options.wantedPaths !== undefined
					? { wantedPaths: options.wantedPaths }
					: {}),
				...(options.cacheNamespace !== undefined
					? { cacheNamespace: options.cacheNamespace }
					: {}),
				...(options.indexedDbLayout !== undefined
					? { indexedDbLayout: options.indexedDbLayout }
					: {}),
				...(options.cacheFallback !== undefined
					? { cacheFallback: options.cacheFallback }
					: {}),
			},
			options.onProgress,
		);
		if (response.ok && response.kind === "sync") {
			return response.result;
		}
		throw this.#errorOf(response);
	}

	/** Materialize a synced file's bytes from the active manifest. Pass the
	 * same `cacheFallback` as sync when readFile may be the Worker's first call. */
	public async readFile(
		path: string,
		options: Pick<EngineStorageOptions, "cacheFallback"> = {},
	): Promise<Uint8Array> {
		const response = await this.#send({
			kind: "readFile",
			id: this.#allocId(),
			path,
			...(options.cacheFallback === undefined
				? {}
				: { cacheFallback: options.cacheFallback }),
		});
		if (response.ok && response.kind === "readFile") {
			return response.bytes;
		}
		throw this.#errorOf(response);
	}

	/** Clear this Worker's durable cache under the same lock used by sync/read. */
	public async clear(options: EngineStorageOptions = {}): Promise<void> {
		const response = await this.#send({
			kind: "clear",
			id: this.#allocId(),
			...(options.cacheNamespace === undefined
				? {}
				: { cacheNamespace: options.cacheNamespace }),
			...(options.indexedDbLayout === undefined
				? {}
				: { indexedDbLayout: options.indexedDbLayout }),
			...(options.cacheFallback === undefined
				? {}
				: { cacheFallback: options.cacheFallback }),
		});
		if (response.ok && response.kind === "clear") return;
		throw this.#errorOf(response);
	}

	/** Reject in-flight work and release the sync worker. Safe to call twice. */
	public dispose(): void {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		this.#onCrash("engine worker disposed");
	}

	/** Backwards-compatible alias for callers that own the raw worker lifecycle. */
	public terminate(): void {
		this.dispose();
	}

	#allocId(): number {
		this.#nextId += 1;
		return this.#nextId;
	}

	#errorOf(response: EngineResponse): Error {
		return response.ok
			? new Error("unexpected response kind")
			: engineErrorOf(response.error);
	}

	#send(
		request: EngineRequest,
		onProgress?: (progress: SyncProgress) => void,
	): Promise<EngineResponse> {
		if (this.#crash !== undefined) {
			return Promise.reject(this.#crash);
		}
		return new Promise<EngineResponse>((resolve, reject) => {
			const pending: Pending = {
				resolve,
				reject,
				request,
				...(onProgress === undefined ? {} : { onProgress }),
				timer: undefined,
			};
			pending.timer = this.#deadline(pending);
			this.#pending.set(request.id, pending);
			try {
				this.#worker.postMessage(request);
			} catch (error) {
				this.#onCrash(
					error instanceof Error ? error.message : "worker postMessage failed",
				);
			}
		});
	}

	#deadline(pending: Pending): ReturnType<typeof setTimeout> {
		return setTimeout(() => {
			this.#pending.delete(pending.request.id);
			pending.reject(
				new WorkerTimeoutError(
					`engine request ${pending.request.id} (${pending.request.kind}) was idle for ${this.#timeoutMs}ms`,
				),
			);
			this.#onCrash(
				`request ${pending.request.id} (${pending.request.kind}) was idle for ${this.#timeoutMs}ms`,
			);
		}, this.#timeoutMs);
	}

	#onMessage(response: EngineResponse): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) {
			return;
		}
		if (response.ok && response.kind === "syncProgress") {
			if (pending.request.kind === "sync") {
				clearTimeout(pending.timer);
				pending.timer = this.#deadline(pending);
				try {
					pending.onProgress?.(response.progress);
				} catch {
					// Observability cannot terminate or settle the integrity operation.
				}
			}
			return;
		}
		this.#pending.delete(response.id);
		clearTimeout(pending.timer);
		pending.resolve(response);
	}

	#onCrash(reason: string): void {
		this.#crash ??= new WorkerCrashError(`engine worker crashed: ${reason}`);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(this.#crash);
		}
		this.#pending.clear();
		this.#releaseWorker();
	}

	/** Terminate exactly once, however many failure paths reach it. */
	#releaseWorker(): void {
		if (this.#released) {
			return;
		}
		this.#released = true;
		this.#worker.terminate();
	}
}
