// The SQL engine that runs INSIDE the Worker, on the official sqlite-wasm OO1
// API. It owns one connection to the pinned build (SQLite 3.53.4 compiled with
// FTS5 and JSON1, plus sqlite-vector 1.1.2), so one database can hold rows, an
// FTS5 index and vectors and join them in one query. Nothing here re-implements
// SQL: every call is a prepared statement on that connection.
import { applyMemoryProfile, readMemoryProfile, } from "../sqlite/memoryProfile.js";
import { exportDatabase, importDatabase } from "./portable.js";
export const PINNED_SQLITE_VERSION = "3.53.4";
export const PINNED_VECTOR_VERSION = "1.1.2";
export class SqlEngine {
    #raw;
    #storage;
    #serializer;
    #statements = new Map();
    #nextStatement = 1;
    constructor(raw, options) {
        this.#raw = raw;
        this.#storage = options.storage;
        this.#serializer = options.serializer;
        assertPinnedRuntime(raw);
        applyMemoryProfile(profileHandle(raw), options.memoryProfile);
        if (options.storage.persistence === "opfs")
            applyPrivacyPragmas(raw);
    }
    exec(sql, bind) {
        return this.#counting(() => this.#raw.exec(bind === undefined ? { sql } : { sql, bind: normalizeBind(bind) })).result;
    }
    query(sql, bind) {
        const statement = this.#raw.prepare(sql);
        try {
            return collect(statement, bind);
        }
        finally {
            statement.finalize();
        }
    }
    transaction(statements) {
        const { value, result } = this.#counting(() => this.#raw.transaction("IMMEDIATE", () => statements.map((statement) => this.#runInTransaction(statement))));
        return { changes: result.changes, results: value };
    }
    executeMany(sql, rows) {
        return this.#counting(() => this.#raw.transaction("IMMEDIATE", () => this.#runInTransaction({ sql, rows }))).result;
    }
    prepare(sql) {
        const id = this.#nextStatement++;
        this.#statements.set(id, this.#raw.prepare(sql));
        return id;
    }
    runPrepared(id, bind) {
        const statement = this.#prepared(id);
        return this.#counting(() => collect(statement, bind)).result;
    }
    allPrepared(id, bind) {
        return collect(this.#prepared(id), bind);
    }
    finalize(id) {
        this.#prepared(id).finalize();
        this.#statements.delete(id);
    }
    /** Start an interactive transaction; the client holds its lock until it ends. */
    begin() {
        this.#raw.exec({ sql: "BEGIN IMMEDIATE" });
    }
    commit() {
        this.#raw.exec({ sql: "COMMIT" });
    }
    /** Roll back; a no-op when SQLite already ended the transaction itself. */
    rollback() {
        try {
            this.#raw.exec({ sql: "ROLLBACK" });
        }
        catch (error) {
            if (!/no transaction is active/.test(describeError(error)))
                throw error;
        }
    }
    /** The whole database as a SQLite file (sqlite3_serialize). */
    exportDatabase() {
        return exportDatabase(this.#raw, this.#requireSerializer());
    }
    /** Validate `bytes`, then replace this database with it in one transaction. */
    importDatabase(bytes, options) {
        return importDatabase(this.#raw, this.#requireSerializer(), bytes, options);
    }
    runtimeInfo() {
        const versions = pinnedVersions(this.#raw);
        const json = this.#raw.selectObjects("SELECT json_valid('{}') AS ok")[0];
        return {
            sqliteVersion: String(versions?.sqlite),
            vectorVersion: String(versions?.vector),
            fts5: versions?.fts5 === 1,
            json1: json?.ok === 1,
            memoryProfile: readMemoryProfile(profileHandle(this.#raw)),
            storage: this.#storage,
        };
    }
    close() {
        for (const statement of this.#statements.values())
            statement.finalize();
        this.#statements.clear();
        this.#raw.close();
    }
    #runInTransaction(statement) {
        const prepared = this.#raw.prepare(statement.sql);
        try {
            if ("rows" in statement) {
                for (const row of statement.rows)
                    collect(prepared, row);
                return [];
            }
            return collect(prepared, statement.bind);
        }
        finally {
            prepared.finalize();
        }
    }
    #requireSerializer() {
        if (this.#serializer === undefined) {
            throw new Error("this SQL engine was opened without a serializer");
        }
        return this.#serializer;
    }
    #prepared(id) {
        const statement = this.#statements.get(id);
        if (statement === undefined) {
            throw new Error(`prepared statement ${id} is not open`);
        }
        return statement;
    }
    #counting(action) {
        const before = totalChanges(this.#raw);
        const value = action();
        const row = this.#raw.selectObjects("SELECT total_changes() AS total, last_insert_rowid() AS rowid")[0];
        return {
            value,
            result: {
                changes: Number(row?.total) - before,
                lastInsertRowid: row?.rowid,
            },
        };
    }
}
function collect(statement, bind) {
    try {
        if (bind !== undefined)
            statement.bind(normalizeBind(bind));
        const rows = [];
        while (statement.step())
            rows.push(statement.get({}));
        return rows;
    }
    finally {
        statement.reset(true);
    }
}
function normalizeBind(bind) {
    if (Array.isArray(bind))
        return bind.map(normalizeValue);
    return Object.fromEntries(Object.entries(bind).map(([key, value]) => [key, normalizeValue(value)]));
}
/** Bind any typed array as its raw bytes — the BLOB layout sqlite-vector reads. */
function normalizeValue(value) {
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return value;
}
function profileHandle(raw) {
    return {
        exec: (sql) => {
            raw.exec({ sql });
        },
        selectObjects: (sql) => raw.selectObjects(sql),
    };
}
function totalChanges(raw) {
    return Number(raw.selectObjects("SELECT total_changes() AS total")[0]?.total);
}
function pinnedVersions(raw) {
    return raw.selectObjects("SELECT sqlite_version() AS sqlite, vector_version() AS vector, sqlite_compileoption_used('ENABLE_FTS5') AS fts5")[0];
}
/** Refuse any build other than the pinned one: FTS5 and vectors must be there. */
function assertPinnedRuntime(raw) {
    const row = pinnedVersions(raw);
    if (row?.sqlite !== PINNED_SQLITE_VERSION ||
        row.vector !== PINNED_VECTOR_VERSION ||
        row.fts5 !== 1) {
        throw new Error(`unexpected SQLite runtime: ${JSON.stringify(row)}`);
    }
}
/** Deleted rows are zeroed and no rollback journal outlives a transaction. */
function applyPrivacyPragmas(raw) {
    raw.exec({ sql: "PRAGMA secure_delete = ON" });
    const journal = raw.selectObjects("PRAGMA journal_mode = DELETE")[0]
        ?.journal_mode;
    const secureDelete = raw.selectObjects("PRAGMA secure_delete")[0]
        ?.secure_delete;
    if (journal !== "delete" || secureDelete !== 1) {
        throw new Error("persistent SQLite privacy pragmas were not applied");
    }
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=engine.js.map