// Main-thread proxy for the library's SQL Worker. Every call is one message;
// the Worker runs them one at a time on a single SQLite connection.
import { SqlStorageUnavailableError, } from "./types.js";
/**
 * Open a named SQLite database in the library's Worker: OPFS (opfs-sahpool)
 * with the device memory profile applied, FTS5, JSON1 and sqlite-vector on the
 * same connection. Check `storage` to see whether it fell back to memory.
 */
export async function openSqlDatabase(options, { workerFactory = defaultWorkerFactory } = {}) {
    const connection = new Connection(workerFactory());
    try {
        const storage = (await connection.request({
            operation: "open",
            options,
        }));
        return new WorkerSqlDatabase(options.name, storage, connection);
    }
    catch (error) {
        connection.terminate(error);
        throw error;
    }
}
class Connection {
    #worker;
    #pending = new Map();
    #nextId = 1;
    #terminal;
    constructor(worker) {
        this.#worker = worker;
        worker.addEventListener("message", (event) => this.#receive(event.data));
        worker.addEventListener("error", (event) => this.terminate(new Error(`SQL worker failed: ${event.message}`)));
        worker.addEventListener("messageerror", () => this.terminate(new Error("SQL worker returned an unreadable message")));
    }
    request(request) {
        if (this.#terminal !== undefined)
            return Promise.reject(this.#terminal);
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage({ ...request, id });
        });
    }
    terminate(error) {
        this.#terminal ??= error;
        this.#worker.terminate();
        for (const pending of this.#pending.values())
            pending.reject(error);
        this.#pending.clear();
    }
    #receive(response) {
        const pending = this.#pending.get(response.id);
        if (pending === undefined)
            return;
        this.#pending.delete(response.id);
        if (response.ok)
            pending.resolve(response.value);
        else
            pending.reject(reconstructError(response.error));
    }
}
class WorkerSqlDatabase {
    name;
    storage;
    #connection;
    #closed = false;
    constructor(name, storage, connection) {
        this.name = name;
        this.storage = storage;
        this.#connection = connection;
    }
    exec(sql, bind) {
        return this.#call({ operation: "exec", sql, ...withBind(bind) });
    }
    query(sql, bind) {
        return this.#call({ operation: "query", sql, ...withBind(bind) });
    }
    transaction(statements) {
        return this.#call({ operation: "transaction", statements });
    }
    executeMany(sql, rows) {
        return this.#call({ operation: "execute-many", sql, rows });
    }
    async prepare(sql) {
        const statement = await this.#call({ operation: "prepare", sql });
        return {
            run: (bind) => this.#call({ operation: "run-prepared", statement, ...withBind(bind) }),
            all: (bind) => this.#call({ operation: "all-prepared", statement, ...withBind(bind) }),
            finalize: () => this.#call({ operation: "finalize", statement }),
        };
    }
    runtimeInfo() {
        return this.#call({ operation: "runtime-info" });
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        try {
            await this.#connection.request({ operation: "close" });
        }
        finally {
            this.#connection.terminate(new Error("SQL database is closed"));
        }
    }
    #call(request) {
        if (this.#closed) {
            return Promise.reject(new Error("SQL database is closed"));
        }
        return this.#connection.request(request);
    }
}
function withBind(bind) {
    return bind === undefined ? {} : { bind };
}
function reconstructError(error) {
    if (error.name === "SqlStorageUnavailableError" &&
        error.reason !== undefined) {
        return new SqlStorageUnavailableError(error.reason, error.message);
    }
    const reconstructed = new Error(error.message);
    reconstructed.name = error.name;
    return reconstructed;
}
function defaultWorkerFactory() {
    return new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
        name: "edgeproc-sql",
    });
}
//# sourceMappingURL=client.js.map