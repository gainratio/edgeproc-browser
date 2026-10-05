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
import { DEFAULT_REQUEST_TIMEOUT_MS, WorkerCrashError, WorkerTimeoutError, } from "./workerFault.js";
export class EngineClient {
    #worker;
    #pending = new Map();
    #timeoutMs;
    #nextId = 0;
    #crash;
    #disposed = false;
    #released = false;
    constructor(worker, options = {}) {
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
    async sync(baseUrl, pubkeyUrl, identityOrOptions, expectedChannel, controls = {}) {
        const options = typeof identityOrOptions === "object" && identityOrOptions !== null
            ? identityOrOptions
            : {
                ...controls,
                ...(identityOrOptions !== undefined
                    ? { expectedBundleId: identityOrOptions }
                    : {}),
                ...(expectedChannel !== undefined ? { expectedChannel } : {}),
            };
        const response = await this.#send({
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
        }, options.onProgress);
        if (response.ok && response.kind === "sync") {
            return response.result;
        }
        throw this.#errorOf(response);
    }
    /** Materialize a synced file's bytes from the active manifest. Pass the
     * same `cacheFallback` as sync when readFile may be the Worker's first call. */
    async readFile(path, options = {}) {
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
    async clear(options = {}) {
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
        if (response.ok && response.kind === "clear")
            return;
        throw this.#errorOf(response);
    }
    /** Reject in-flight work and release the sync worker. Safe to call twice. */
    dispose() {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#onCrash("engine worker disposed");
    }
    /** Backwards-compatible alias for callers that own the raw worker lifecycle. */
    terminate() {
        this.dispose();
    }
    #allocId() {
        this.#nextId += 1;
        return this.#nextId;
    }
    #errorOf(response) {
        return response.ok
            ? new Error("unexpected response kind")
            : engineErrorOf(response.error);
    }
    #send(request, onProgress) {
        if (this.#crash !== undefined) {
            return Promise.reject(this.#crash);
        }
        return new Promise((resolve, reject) => {
            const pending = {
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
            }
            catch (error) {
                this.#onCrash(error instanceof Error ? error.message : "worker postMessage failed");
            }
        });
    }
    #deadline(pending) {
        return setTimeout(() => {
            this.#pending.delete(pending.request.id);
            pending.reject(new WorkerTimeoutError(`engine request ${pending.request.id} (${pending.request.kind}) was idle for ${this.#timeoutMs}ms`));
            this.#onCrash(`request ${pending.request.id} (${pending.request.kind}) was idle for ${this.#timeoutMs}ms`);
        }, this.#timeoutMs);
    }
    #onMessage(response) {
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
                }
                catch {
                    // Observability cannot terminate or settle the integrity operation.
                }
            }
            return;
        }
        this.#pending.delete(response.id);
        clearTimeout(pending.timer);
        pending.resolve(response);
    }
    #onCrash(reason) {
        this.#crash ??= new WorkerCrashError(`engine worker crashed: ${reason}`);
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(this.#crash);
        }
        this.#pending.clear();
        this.#releaseWorker();
    }
    /** Terminate exactly once, however many failure paths reach it. */
    #releaseWorker() {
        if (this.#released) {
            return;
        }
        this.#released = true;
        this.#worker.terminate();
    }
}
//# sourceMappingURL=client.js.map