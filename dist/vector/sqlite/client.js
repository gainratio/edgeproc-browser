import { SqlStorageUnavailableError } from "../../sql/types.js";
const PERSISTENT_CAPABILITIES = Object.freeze({
    metrics: Object.freeze(["cosine"]),
    exact: true,
    persistent: true,
    metadataFiltering: true,
    scopedDelete: true,
});
/** Worker proxy that keeps synchronous SQLite and OPFS access off the UI thread. */
export class SqliteVectorIndexClient {
    name;
    dimension;
    capabilities;
    #worker;
    #pending = new Map();
    #ready;
    #nextId = 1;
    #disposed = false;
    #terminalError;
    constructor(options, workerFactory = defaultWorkerFactory) {
        this.name = options.name;
        this.dimension = options.dimension;
        this.capabilities = Object.freeze({
            ...PERSISTENT_CAPABILITIES,
            persistent: (options.persistence ?? "opfs") === "opfs",
        });
        this.#worker = workerFactory();
        this.#worker.addEventListener("message", (event) => {
            this.#receive(event.data);
        });
        this.#worker.addEventListener("error", (event) => {
            this.#failTerminal(new Error(`SQLite vector worker failed: ${event.message}`));
        });
        this.#worker.addEventListener("messageerror", () => {
            this.#failTerminal(new Error("SQLite vector worker returned an unreadable message"));
        });
        this.#ready = this.#request({ operation: "initialize", options })
            .then(() => undefined)
            .catch((reason) => {
            const error = reason instanceof Error ? reason : new Error(String(reason));
            this.#failTerminal(error);
            throw error;
        });
    }
    ready() {
        return this.#ready;
    }
    async insert(records) {
        await this.#ready;
        await this.#request({ operation: "insert", records });
    }
    async insertKeyed(records) {
        await this.#ready;
        await this.#request({ operation: "insert-keyed", records });
    }
    async read(id) {
        await this.#ready;
        return (await this.#request({
            operation: "read",
            recordId: id,
        }));
    }
    async search(query, limit, filters) {
        await this.#ready;
        return (await this.#request({
            operation: "search",
            query,
            limit,
            ...(filters === undefined ? {} : { filters }),
        }));
    }
    async searchByIds(query, ids) {
        await this.#ready;
        return (await this.#request({
            operation: "search-by-ids",
            query,
            ids,
        }));
    }
    async lookupIds(keys, maxDocumentFrequency) {
        await this.#ready;
        return (await this.#request({
            operation: "lookup-ids",
            keys,
            maxDocumentFrequency,
        }));
    }
    async delete(ids, filters) {
        await this.#ready;
        return (await this.#request({
            operation: "delete",
            ids,
            ...(filters === undefined ? {} : { filters }),
        }));
    }
    async deleteWhere(filters) {
        await this.#ready;
        return (await this.#request({
            operation: "delete-where",
            filters,
        }));
    }
    async clear() {
        await this.#ready;
        return (await this.#request({ operation: "clear" }));
    }
    async stats(filters) {
        await this.#ready;
        return (await this.#request({
            operation: "stats",
            ...(filters === undefined ? {} : { filters }),
        }));
    }
    async runtimeInfo() {
        await this.#ready;
        return (await this.#request({
            operation: "runtime-info",
        }));
    }
    async dispose() {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        try {
            await this.#ready;
            await this.#request({ operation: "dispose" }, true);
        }
        finally {
            this.#worker.terminate();
            this.#failAll(new Error("SQLite vector index is disposed"));
        }
    }
    #request(request, allowDisposed = false) {
        if (this.#disposed && !allowDisposed) {
            return Promise.reject(new Error("SQLite vector index is disposed"));
        }
        if (this.#terminalError !== undefined) {
            return Promise.reject(this.#terminalError);
        }
        const id = this.#nextId;
        this.#nextId += 1;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage({ ...request, id });
        });
    }
    #receive(response) {
        const pending = this.#pending.get(response.id);
        if (pending === undefined) {
            return;
        }
        this.#pending.delete(response.id);
        if (response.ok) {
            pending.resolve(response.value);
        }
        else {
            pending.reject(reconstructError(response.error));
        }
    }
    #failAll(error) {
        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }
        this.#pending.clear();
    }
    #failTerminal(error) {
        this.#terminalError = error;
        this.#worker.terminate();
        this.#failAll(error);
    }
}
/** Rebuild the typed refusal the Worker sent; anything else stays a named Error. */
function reconstructError(error) {
    if (error.name === "SqlStorageUnavailableError" &&
        error.reason !== undefined) {
        return new SqlStorageUnavailableError(error.reason, error.message);
    }
    const rebuilt = new Error(error.message);
    rebuilt.name = error.name;
    return rebuilt;
}
export async function createSqliteVectorIndex(options) {
    const index = new SqliteVectorIndexClient(options);
    await index.ready();
    return index;
}
function defaultWorkerFactory() {
    return new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
        name: "edgeproc-sqlite-vector",
    });
}
//# sourceMappingURL=client.js.map