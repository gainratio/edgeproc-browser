// Main-thread proxy for the library's SQL Worker. Every call is one message;
// the Worker runs them one at a time on a single SQLite connection.
import { SqlImportRejectedError, SqlStorageUnavailableError, } from "./types.js";
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
    /** Settles when every call queued so far has been posted or finished. */
    #tail = Promise.resolve();
    /** Transactions (and close) queued or running. */
    #exclusiveCount = 0;
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
    transaction(input) {
        if (typeof input !== "function") {
            return this.#call({ operation: "transaction", statements: input });
        }
        if (this.#closed) {
            return Promise.reject(new Error("SQL database is closed"));
        }
        return this.#exclusive(() => this.#interactive(input));
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
    exportDatabase() {
        return this.#call({ operation: "export" });
    }
    importDatabase(bytes, options) {
        return this.#call({
            operation: "import",
            bytes,
            ...(options === undefined ? {} : { options }),
        });
    }
    migrateLegacySahPool(options) {
        return this.#call({ operation: "migrate-legacy", options });
    }
    runtimeInfo() {
        return this.#call({ operation: "runtime-info" });
    }
    async close() {
        if (this.#closed)
            return;
        this.#closed = true;
        try {
            await this.#exclusive(() => this.#connection.request({ operation: "close" }));
        }
        finally {
            this.#connection.terminate(new Error("SQL database is closed"));
        }
    }
    #call(request) {
        if (this.#closed) {
            return Promise.reject(new Error("SQL database is closed"));
        }
        // No transaction queued or open: post now, so the arguments are copied
        // at the call (as postMessage does) and plain calls pipeline.
        if (this.#exclusiveCount === 0) {
            return this.#connection.request(request);
        }
        // Otherwise wait for it to end, holding a copy taken now.
        const snapshot = structuredClone(request);
        return this.#tail.then(() => this.#connection.request(snapshot));
    }
    /** Run `action` alone: later calls wait until it settles. */
    #exclusive(action) {
        this.#exclusiveCount += 1;
        const run = this.#tail.then(action);
        this.#tail = run.then(() => undefined, () => undefined);
        void this.#tail.then(() => {
            this.#exclusiveCount -= 1;
        });
        return run;
    }
    async #interactive(work) {
        const send = (request) => this.#connection.request(request);
        await send({ operation: "begin" });
        const tx = new ScopedTransaction(send);
        try {
            const value = await work(tx);
            await send({ operation: "commit" });
            return value;
        }
        catch (error) {
            try {
                await send({ operation: "rollback" });
            }
            catch (rollbackError) {
                throw new AggregateError([error, rollbackError], "SQL transaction failed and could not be rolled back");
            }
            throw error;
        }
        finally {
            tx.end();
        }
    }
}
class ScopedTransaction {
    #send;
    #ended = false;
    constructor(send) {
        this.#send = send;
    }
    exec(sql, bind) {
        return this.#run({ operation: "exec", sql, ...withBind(bind) });
    }
    query(sql, bind) {
        return this.#run({ operation: "query", sql, ...withBind(bind) });
    }
    end() {
        this.#ended = true;
    }
    #run(request) {
        if (this.#ended) {
            return Promise.reject(new Error("SQL transaction has ended"));
        }
        return this.#send(request);
    }
}
/**
 * Export a database: an open handle, or a name — opened on OPFS (never a
 * memory fallback) under its owner lock, exported, closed.
 */
export async function exportDatabase(target, options = {}) {
    return withDatabase(target, options, (db) => db.exportDatabase());
}
/**
 * Replace a database with `bytes`: an open handle, or a name. By name it is
 * opened on OPFS under the owner Web Lock, so no other tab or Worker can
 * write while the import runs; if one already has it open, this fails
 * closed with {@link SqlStorageUnavailableError} ("pool-in-use").
 */
export async function importDatabase(target, bytes, options = {}) {
    const { workerFactory, ...importOptions } = options;
    return withDatabase(target, workerFactory === undefined ? {} : { workerFactory }, (db) => db.importDatabase(bytes, importOptions));
}
/**
 * Move a legacy opfs-sahpool database into `to` (an open handle, or a name
 * opened on OPFS under its owner lock, never a memory fallback). See
 * {@link SqlDatabase.migrateLegacySahPool}.
 */
export async function migrateLegacySahPool(options, openOptions = {}) {
    const { to, ...request } = options;
    return withDatabase(to, openOptions, (db) => db.migrateLegacySahPool(request));
}
async function withDatabase(target, options, action) {
    if (typeof target !== "string")
        return action(target);
    const db = await openSqlDatabase({ name: target, persistence: "opfs", fallback: "none" }, options);
    try {
        return await action(db);
    }
    finally {
        await db.close();
    }
}
function withBind(bind) {
    return bind === undefined ? {} : { bind };
}
function reconstructError(error) {
    if (error.name === "SqlImportRejectedError" &&
        error.rejection !== undefined) {
        return new SqlImportRejectedError(error.rejection, error.message);
    }
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