import { applyMemoryProfile, resolveMemoryProfile, } from "../../sqlite/memoryProfile.js";
/** Adapt SQLite's OO1 database surface without leaking it into the index API. */
export function wrapSqliteDatabase(raw) {
    return {
        exec: (sql, bind) => {
            raw.exec(bind === undefined ? { sql } : { sql, bind: [...bind] });
        },
        selectObjects: (sql, bind) => raw.selectObjects(sql, bind === undefined ? undefined : [...bind]),
        transaction: (callback) => raw.transaction(callback),
        close: () => raw.close(),
    };
}
const CAPABILITIES = Object.freeze({
    metrics: Object.freeze(["cosine"]),
    exact: true,
    persistent: true,
    metadataFiltering: true,
    scopedDelete: true,
});
const TABLE = "edgeproc_vectors";
const METADATA_TABLE = "edgeproc_vector_metadata";
const LOOKUP_TABLE = "edgeproc_vector_lookup_keys";
const CONFIG_TABLE = "edgeproc_vector_config";
const SQLITE_MAX_BIND_PARAMETERS = 32_766;
const MAX_LOOKUP_QUERY_KEYS = 64;
/** Exact FLOAT32 cosine index backed by SQLite plus sqlite-vector. */
export class SqliteDatabaseVectorIndex {
    name;
    dimension;
    capabilities;
    #database;
    #disposed = false;
    constructor(options, database, persistent = true) {
        validateOptions(options);
        this.name = options.name;
        this.dimension = options.dimension;
        this.#database = database;
        this.capabilities = persistent
            ? CAPABILITIES
            : Object.freeze({ ...CAPABILITIES, persistent: false });
        if (options.memoryProfile !== undefined) {
            applyMemoryProfile(database, resolveMemoryProfile(options.memoryProfile));
        }
        this.#initialize();
    }
    async insert(records) {
        this.#assertOpen();
        const accepted = records.map((record) => validateAndCopyRecord(record, this.dimension));
        this.#database.transaction(() => {
            for (const record of accepted) {
                this.#replaceRecord(record, []);
            }
        });
    }
    async insertKeyed(records) {
        this.#assertOpen();
        const accepted = records.map((record) => validateAndCopyKeyedRecord(record, this.dimension));
        this.#database.transaction(() => {
            for (const record of accepted) {
                this.#replaceRecord(record, record.lookupKeys);
            }
        });
    }
    async lookupIds(keys, maxDocumentFrequency) {
        this.#assertOpen();
        validateMaxDocumentFrequency(maxDocumentFrequency);
        const unique = uniqueLookupKeys(keys, "lookup keys");
        if (unique.length > MAX_LOOKUP_QUERY_KEYS) {
            throw new RangeError(`lookup query must contain at most ${MAX_LOOKUP_QUERY_KEYS} distinct keys`);
        }
        if (unique.length === 0) {
            return [];
        }
        const values = unique.map(() => "(?, ?, ?)").join(", ");
        const bind = [];
        for (const [ordinal, key] of unique.entries()) {
            bind.push(ordinal, key.namespace, key.value);
        }
        bind.push(maxDocumentFrequency);
        const rows = this.#database.selectObjects(`WITH query_keys(query_ordinal, namespace, lookup_key) AS (VALUES ${values}),
			 eligible_keys AS (
				SELECT q.query_ordinal, q.namespace, q.lookup_key
				FROM query_keys AS q
				JOIN ${LOOKUP_TABLE} AS k
				  ON k.namespace = q.namespace AND k.lookup_key = q.lookup_key
				GROUP BY q.query_ordinal, q.namespace, q.lookup_key
				HAVING COUNT(*) <= ?
			 ),
			 ranked AS (
				SELECT k.record_id, MIN(e.query_ordinal) AS first_query_ordinal
				FROM eligible_keys AS e
				JOIN ${LOOKUP_TABLE} AS k
				  ON k.namespace = e.namespace AND k.lookup_key = e.lookup_key
				GROUP BY k.record_id
			 )
			 SELECT v.id AS id
			 FROM ranked
			 JOIN ${TABLE} AS v ON v.id = ranked.record_id
			 ORDER BY ranked.first_query_ordinal ASC, v.rowid ASC`, bind);
        return rows.map((row) => requireString(row.id, "lookup result id"));
    }
    async read(id) {
        this.#assertOpen();
        validateId(id);
        const row = this.#database.selectObjects(`SELECT id, embedding, metadata_json FROM ${TABLE} WHERE id = ?`, [id])[0];
        return row === undefined ? undefined : decodeRecord(row, this.dimension);
    }
    async search(query, limit, filters) {
        this.#assertOpen();
        validateVector(query, this.dimension, "query");
        validateLimit(limit);
        validateMetadata(filters, "filters");
        if (limit === 0) {
            return [];
        }
        const scoped = filterClause(filters, "v");
        const rows = this.#database.selectObjects(`SELECT v.id AS id, scan.distance AS distance, v.metadata_json AS metadata_json
			 FROM vector_full_scan('${TABLE}', 'embedding', ?) AS scan
			 JOIN ${TABLE} AS v ON v.rowid = scan.rowid
			 ${scoped.sql}
			 ORDER BY scan.distance ASC, v.id COLLATE BINARY ASC
			 LIMIT ?`, [vectorBytes(query), ...scoped.bind, limit]);
        return rows.map(decodeHit);
    }
    async searchByIds(query, ids) {
        this.#assertOpen();
        validateVector(query, this.dimension, "query");
        const unique = uniqueIds(ids);
        if (unique.length === 0) {
            return [];
        }
        const hits = [];
        for (const idsChunk of chunks(unique, SQLITE_MAX_BIND_PARAMETERS - 1)) {
            const placeholders = idsChunk.map(() => "?").join(", ");
            const rows = this.#database.selectObjects(`SELECT v.id AS id, scan.distance AS distance, v.metadata_json AS metadata_json
				 FROM vector_full_scan('${TABLE}', 'embedding', ?) AS scan
				 JOIN ${TABLE} AS v ON v.rowid = scan.rowid
				 WHERE v.id IN (${placeholders})`, [vectorBytes(query), ...idsChunk]);
            hits.push(...rows.map(decodeHit));
        }
        hits.sort((left, right) => left.distance - right.distance || compareCodeUnits(left.id, right.id));
        return hits;
    }
    async delete(ids, filters) {
        this.#assertOpen();
        validateMetadata(filters, "filters");
        const unique = [...new Set(ids)];
        for (const id of unique) {
            validateId(id);
        }
        if (unique.length === 0) {
            return 0;
        }
        const scoped = filterClause(filters, TABLE);
        const placeholders = unique.map(() => "?").join(", ");
        this.#database.exec(`DELETE FROM ${TABLE} WHERE id IN (${placeholders})${scoped.sql.replace("WHERE", " AND")}`, [...unique, ...scoped.bind]);
        return requireFiniteNumber(this.#database.selectObjects("SELECT changes() AS changed")[0]?.changed, "SQLite delete count");
    }
    async deleteWhere(filters) {
        this.#assertOpen();
        validateRequiredMetadata(filters, "filters");
        const scoped = filterClause(filters, TABLE);
        this.#database.exec(`DELETE FROM ${TABLE} ${scoped.sql}`, scoped.bind);
        return changedRowCount(this.#database, "SQLite metadata delete count");
    }
    async clear() {
        this.#assertOpen();
        this.#database.exec(`DELETE FROM ${TABLE}`);
        return changedRowCount(this.#database, "SQLite clear count");
    }
    async stats(filters) {
        this.#assertOpen();
        validateMetadata(filters, "filters");
        const scoped = filterClause(filters, "v");
        const count = requireFiniteNumber(this.#database.selectObjects(`SELECT COUNT(*) AS count FROM ${TABLE} AS v ${scoped.sql}`, scoped.bind)[0]?.count, "SQLite vector count");
        return {
            name: this.name,
            dimension: this.dimension,
            vectorCount: count,
            vectorBytes: count * this.dimension * Float32Array.BYTES_PER_ELEMENT,
        };
    }
    runtimeInfo() {
        this.#assertOpen();
        const versions = this.#database.selectObjects("SELECT sqlite_version() AS sqlite_version, vector_version() AS vector_version, vector_backend() AS vector_backend")[0];
        if (versions === undefined) {
            throw new Error("SQLite runtime did not return version information");
        }
        const extensionRows = this.#database.selectObjects("SELECT name FROM pragma_function_list WHERE name IN ('vector_version', 'sync_version', 'memory_version') ORDER BY name");
        return {
            sqliteVersion: requireString(versions.sqlite_version, "SQLite version"),
            vectorVersion: requireString(versions.vector_version, "sqlite-vector version"),
            vectorBackend: requireString(versions.vector_backend, "sqlite-vector backend"),
            bundledExtensions: extensionRows.map((row) => requireString(row.name, "SQLite extension name")),
        };
    }
    async dispose() {
        if (this.#disposed) {
            return;
        }
        this.#disposed = true;
        this.#database.close();
    }
    #initialize() {
        this.#database.exec("PRAGMA foreign_keys = ON");
        this.#database.exec(`
			CREATE TABLE IF NOT EXISTS ${CONFIG_TABLE}(
				singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
				dimension INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS ${TABLE}(
				id TEXT PRIMARY KEY NOT NULL,
				embedding BLOB NOT NULL,
				metadata_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS ${METADATA_TABLE}(
				record_id TEXT NOT NULL REFERENCES ${TABLE}(id) ON DELETE CASCADE,
				key TEXT NOT NULL,
				kind TEXT NOT NULL,
				value_text TEXT,
				value_number REAL,
				PRIMARY KEY(record_id, key)
			);
			CREATE TABLE IF NOT EXISTS ${LOOKUP_TABLE}(
				record_id TEXT NOT NULL REFERENCES ${TABLE}(id) ON DELETE CASCADE,
				namespace TEXT NOT NULL CHECK(length(namespace) > 0),
				lookup_key TEXT NOT NULL CHECK(length(lookup_key) > 0),
				PRIMARY KEY(record_id, namespace, lookup_key)
			) WITHOUT ROWID;
			CREATE INDEX IF NOT EXISTS edgeproc_vector_lookup_keys_lookup
				ON ${LOOKUP_TABLE}(namespace, lookup_key, record_id);
		`);
        this.#database.exec(`INSERT OR IGNORE INTO ${CONFIG_TABLE}(singleton, dimension) VALUES(1, ?)`, [this.dimension]);
        const storedDimension = requireFiniteNumber(this.#database.selectObjects(`SELECT dimension FROM ${CONFIG_TABLE} WHERE singleton = 1`)[0]?.dimension, "stored vector dimension");
        if (storedDimension !== this.dimension) {
            throw new Error(`vector index ${JSON.stringify(this.name)} has dimension ${storedDimension}; requested ${this.dimension}`);
        }
        this.#database.selectObjects(`SELECT vector_init('${TABLE}', 'embedding', ?) AS initialized`, [`dimension=${this.dimension},type=FLOAT32,distance=COSINE`]);
    }
    #assertOpen() {
        if (this.#disposed) {
            throw new Error(`vector index ${JSON.stringify(this.name)} is disposed`);
        }
    }
    #replaceRecord(record, lookupKeys) {
        this.#database.exec(`DELETE FROM ${TABLE} WHERE id = ?`, [record.id]);
        this.#database.exec(`INSERT INTO ${TABLE}(id, embedding, metadata_json) VALUES(?, vector_as_f32(?), ?)`, [record.id, vectorBytes(record.vector), JSON.stringify(record.metadata)]);
        for (const [key, value] of Object.entries(record.metadata)) {
            const encoded = encodeScalar(value);
            this.#database.exec(`INSERT INTO ${METADATA_TABLE}(record_id, key, kind, value_text, value_number) VALUES(?, ?, ?, ?, ?)`, [record.id, key, encoded.kind, encoded.text, encoded.number]);
        }
        for (const key of lookupKeys) {
            this.#database.exec(`INSERT INTO ${LOOKUP_TABLE}(record_id, namespace, lookup_key) VALUES(?, ?, ?)`, [record.id, key.namespace, key.value]);
        }
    }
}
function encodeScalar(value) {
    if (value === null) {
        return { kind: "null", text: null, number: null };
    }
    switch (typeof value) {
        case "string":
            return { kind: "string", text: value, number: null };
        case "number":
            return { kind: "number", text: null, number: value };
        case "boolean":
            return { kind: "boolean", text: null, number: value ? 1 : 0 };
    }
}
function filterClause(filters, recordAlias) {
    if (filters === undefined || Object.keys(filters).length === 0) {
        return { sql: "", bind: [] };
    }
    const clauses = [];
    const bind = [];
    let index = 0;
    for (const [key, value] of Object.entries(filters)) {
        const alias = `filter_${index}`;
        const encoded = encodeScalar(value);
        clauses.push(`EXISTS (SELECT 1 FROM ${METADATA_TABLE} AS ${alias} WHERE ${alias}.record_id = ${recordAlias}.id AND ${alias}.key = ? AND ${alias}.kind = ? AND ${alias}.value_text IS ? AND ${alias}.value_number IS ?)`);
        bind.push(key, encoded.kind, encoded.text, encoded.number);
        index += 1;
    }
    return { sql: `WHERE ${clauses.join(" AND ")}`, bind };
}
function validateOptions(options) {
    if (!Number.isInteger(options.dimension) || options.dimension < 1) {
        throw new RangeError("vector dimension must be an integer >= 1");
    }
    if (options.name.length === 0) {
        throw new TypeError("vector index name must not be empty");
    }
}
function validateAndCopyRecord(record, dimension) {
    validateId(record.id);
    validateVector(record.vector, dimension, `record ${JSON.stringify(record.id)}`);
    validateMetadata(record.metadata, `record ${JSON.stringify(record.id)} metadata`);
    return {
        id: record.id,
        vector: record.vector.slice(),
        metadata: { ...record.metadata },
    };
}
function validateAndCopyKeyedRecord(record, dimension) {
    const vectorRecord = validateAndCopyRecord(record, dimension);
    return {
        ...vectorRecord,
        lookupKeys: uniqueLookupKeys(record.lookupKeys, `record ${JSON.stringify(record.id)} lookup keys`),
    };
}
function uniqueLookupKeys(keys, at) {
    if (!Array.isArray(keys)) {
        throw new TypeError(`${at} must be an array`);
    }
    const seen = new Set();
    const unique = [];
    for (const key of keys) {
        validateLookupKey(key, at);
        const identity = JSON.stringify([key.namespace, key.value]);
        if (!seen.has(identity)) {
            seen.add(identity);
            unique.push({ namespace: key.namespace, value: key.value });
        }
    }
    return unique;
}
function validateLookupKey(key, at) {
    if (typeof key !== "object" || key === null) {
        throw new TypeError(`${at} must contain lookup key objects`);
    }
    if (typeof key.namespace !== "string" || key.namespace.length === 0) {
        throw new TypeError(`${at} contains an empty namespace`);
    }
    if (typeof key.value !== "string" || key.value.length === 0) {
        throw new TypeError(`${at} contains an empty value`);
    }
}
function validateMaxDocumentFrequency(maxDocumentFrequency) {
    if (!Number.isInteger(maxDocumentFrequency) || maxDocumentFrequency < 1) {
        throw new RangeError("maximum document frequency must be an integer >= 1");
    }
}
function validateId(id) {
    if (typeof id !== "string" || id.length === 0) {
        throw new TypeError("vector record id must not be empty");
    }
}
function uniqueIds(ids) {
    const unique = new Set();
    for (const id of ids) {
        validateId(id);
        unique.add(id);
    }
    return [...unique];
}
function* chunks(values, size) {
    for (let start = 0; start < values.length; start += size) {
        yield values.slice(start, start + size);
    }
}
function validateVector(vector, dimension, at) {
    if (!(vector instanceof Float32Array)) {
        throw new TypeError(`${at} must be a Float32Array`);
    }
    if (vector.length !== dimension) {
        throw new RangeError(`${at} has dimension ${vector.length}; expected ${dimension}`);
    }
    for (const value of vector) {
        if (!Number.isFinite(value)) {
            throw new TypeError(`${at} contains a non-finite value`);
        }
    }
}
function validateLimit(limit) {
    if (!Number.isInteger(limit) || limit < 0) {
        throw new RangeError("search limit must be a non-negative integer");
    }
}
function validateMetadata(metadata, at) {
    if (metadata === undefined) {
        return;
    }
    for (const [key, value] of Object.entries(metadata)) {
        if (key.length === 0) {
            throw new TypeError(`${at} contains an empty key`);
        }
        if (value !== null &&
            typeof value !== "string" &&
            typeof value !== "number" &&
            typeof value !== "boolean") {
            throw new TypeError(`${at}.${key} must be a scalar`);
        }
        if (typeof value === "number" && !Number.isFinite(value)) {
            throw new TypeError(`${at}.${key} must be finite`);
        }
    }
}
function validateRequiredMetadata(metadata, at) {
    validateMetadata(metadata, at);
    if (Object.keys(metadata).length === 0) {
        throw new TypeError(`${at} must contain at least one filter`);
    }
}
function changedRowCount(database, at) {
    return requireFiniteNumber(database.selectObjects("SELECT changes() AS changed")[0]?.changed, at);
}
function vectorBytes(vector) {
    return new Uint8Array(vector.slice().buffer);
}
function decodeRecord(row, dimension) {
    const bytes = row.embedding;
    if (!(bytes instanceof Uint8Array)) {
        throw new TypeError("SQLite returned a non-BLOB embedding");
    }
    const copy = bytes.slice();
    const vector = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
    validateVector(vector, dimension, "stored vector");
    return {
        id: requireString(row.id, "stored vector id"),
        vector,
        metadata: decodeMetadata(row.metadata_json),
    };
}
function decodeHit(row) {
    return {
        id: requireString(row.id, "search result id"),
        distance: requireFiniteNumber(row.distance, "search result distance"),
        metadata: decodeMetadata(row.metadata_json),
    };
}
function decodeMetadata(value) {
    const json = requireString(value, "stored metadata");
    const parsed = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new TypeError("stored metadata is not an object");
    }
    const metadata = parsed;
    validateMetadata(metadata, "stored metadata");
    return { ...metadata };
}
function requireString(value, at) {
    if (typeof value !== "string") {
        throw new TypeError(`${at} was not a string`);
    }
    return value;
}
function requireFiniteNumber(value, at) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${at} was not a finite number`);
    }
    return value;
}
function compareCodeUnits(left, right) {
    if (left === right) {
        return 0;
    }
    return left < right ? -1 : 1;
}
//# sourceMappingURL=database.js.map