import {
	applyMemoryProfile,
	type MemoryProfileSetting,
	resolveMemoryProfile,
} from "../../sqlite/memoryProfile.js";
import type {
	Metadata,
	Scalar,
	VectorHit,
	VectorIndex,
	VectorIndexCapabilities,
	VectorIndexOptions,
	VectorRecord,
	VectorStats,
} from "../types.js";

export type SqliteValue = string | number | null | Uint8Array;

/** Index options plus the SQLite memory profile ("auto" sizes it to the device). */
export interface SqliteVectorIndexOptions extends VectorIndexOptions {
	readonly memoryProfile?: MemoryProfileSetting;
}

/** Minimal synchronous SQLite surface used by the adapter and its test seam. */
export interface SqliteDatabase {
	exec(sql: string, bind?: ReadonlyArray<SqliteValue>): void;
	selectObjects(
		sql: string,
		bind?: ReadonlyArray<SqliteValue>,
	): ReadonlyArray<Readonly<Record<string, unknown>>>;
	transaction<T>(callback: () => T): T;
	close(): void;
}

/** Raw SQLite OO1 shape shared by browser Worker and Node-only adapters. */
export interface RawSqliteDatabase {
	exec(options: { readonly sql: string; readonly bind?: unknown[] }): unknown;
	selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
	transaction<T>(callback: () => T): T;
	close(): void;
}

export interface SqliteVectorRuntimeInfo {
	readonly sqliteVersion: string;
	readonly vectorVersion: string;
	readonly vectorBackend: string;
	readonly bundledExtensions: ReadonlyArray<string>;
}

/** A caller-defined exact lookup term stored beside a vector record. */
export interface SqliteLookupKey {
	readonly namespace: string;
	readonly value: string;
}

/** A vector record with exact lookup terms for bounded candidate retrieval. */
export interface SqliteKeyedVectorRecord extends VectorRecord {
	readonly lookupKeys: ReadonlyArray<SqliteLookupKey>;
}

/** Adapt SQLite's OO1 database surface without leaking it into the index API. */
export function wrapSqliteDatabase(raw: RawSqliteDatabase): SqliteDatabase {
	return {
		exec: (sql, bind) => {
			raw.exec(bind === undefined ? { sql } : { sql, bind: [...bind] });
		},
		selectObjects: (sql, bind) =>
			raw.selectObjects(sql, bind === undefined ? undefined : [...bind]),
		transaction: (callback) => raw.transaction(callback),
		close: () => raw.close(),
	};
}

const CAPABILITIES: VectorIndexCapabilities = Object.freeze({
	metrics: Object.freeze(["cosine"] as const),
	exact: true,
	persistent: true,
	metadataFiltering: true,
	scopedDelete: true,
});

const TABLE = "edgeproc_vectors";
const METADATA_TABLE = "edgeproc_vector_metadata";
const LOOKUP_TABLE = "edgeproc_vector_lookup_keys";
const CONFIG_TABLE = "edgeproc_vector_config";
const QUANTIZE_TABLE = `vector0_${TABLE}_embedding`;
const SQLITE_MAX_BIND_PARAMETERS = 32_766;
const MAX_LOOKUP_QUERY_KEYS = 64;
const TURBOQUANT_MIN_ROWS = 256;
const TURBOQUANT_OVERSAMPLE_FACTOR = 8;
const TURBOQUANT_MIN_CANDIDATES = 512;
const DIRECT_ID_LOOKUP_THRESHOLD = 256;
const BATCH_INSERT_RUN_LIMIT = 512;

/** Exact FLOAT32 cosine index backed by SQLite plus sqlite-vector. */
export class SqliteDatabaseVectorIndex implements VectorIndex {
	public readonly name: string;
	public readonly dimension: number;
	public readonly capabilities: VectorIndexCapabilities;
	readonly #database: SqliteDatabase;
	#disposed = false;
	#quantizeReady = false;
	#mutated = false;

	public constructor(
		options: SqliteVectorIndexOptions,
		database: SqliteDatabase,
		persistent = true,
	) {
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

	public async insert(records: ReadonlyArray<VectorRecord>): Promise<void> {
		this.#assertOpen();
		const accepted = records.map((record) => ({
			...validateAndCopyRecord(record, this.dimension),
			lookupKeys: [] as ReadonlyArray<SqliteLookupKey>,
		}));
		this.#database.transaction(() => {
			this.#replaceRecords(accepted);
		});
		this.#invalidateQuantize();
	}

	public async insertKeyed(
		records: ReadonlyArray<SqliteKeyedVectorRecord>,
	): Promise<void> {
		this.#assertOpen();
		const accepted = records.map((record) =>
			validateAndCopyKeyedRecord(record, this.dimension),
		);
		this.#database.transaction(() => {
			this.#replaceRecords(accepted);
		});
		this.#invalidateQuantize();
	}

	public async lookupIds(
		keys: ReadonlyArray<SqliteLookupKey>,
		maxDocumentFrequency: number,
	): Promise<ReadonlyArray<string>> {
		this.#assertOpen();
		validateMaxDocumentFrequency(maxDocumentFrequency);
		const unique = uniqueLookupKeys(keys, "lookup keys");
		if (unique.length > MAX_LOOKUP_QUERY_KEYS) {
			throw new RangeError(
				`lookup query must contain at most ${MAX_LOOKUP_QUERY_KEYS} distinct keys`,
			);
		}
		if (unique.length === 0) {
			return [];
		}

		const values = unique.map(() => "(?, ?, ?)").join(", ");
		const bind: SqliteValue[] = [];
		for (const [ordinal, key] of unique.entries()) {
			bind.push(ordinal, key.namespace, key.value);
		}
		bind.push(maxDocumentFrequency);
		const rows = this.#database.selectObjects(
			`WITH query_keys(query_ordinal, namespace, lookup_key) AS (VALUES ${values}),
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
			 ORDER BY ranked.first_query_ordinal ASC, v.rowid ASC`,
			bind,
		);
		return rows.map((row) => requireString(row.id, "lookup result id"));
	}

	public async read(id: string): Promise<VectorRecord | undefined> {
		this.#assertOpen();
		validateId(id);
		const row = this.#database.selectObjects(
			`SELECT id, embedding, metadata_json FROM ${TABLE} WHERE id = ?`,
			[id],
		)[0];
		return row === undefined ? undefined : decodeRecord(row, this.dimension);
	}

	public async search(
		query: Float32Array,
		limit: number,
		filters?: Metadata,
	): Promise<ReadonlyArray<VectorHit>> {
		this.#assertOpen();
		validateVector(query, this.dimension, "query");
		validateLimit(limit);
		validateMetadata(filters, "filters");
		if (limit === 0) {
			return [];
		}

		const scoped = filterClause(filters, "v");
		if (scoped.sql.length === 0) {
			const rowCount = this.#unscopedRowCount();
			if (rowCount >= TURBOQUANT_MIN_ROWS) {
				const quantizedHits = this.#trySearchTurboQuant(query, limit, rowCount);
				if (quantizedHits !== undefined) {
					return quantizedHits;
				}
			}
		}
		const rows = this.#database.selectObjects(
			`SELECT v.id AS id, scan.distance AS distance, v.metadata_json AS metadata_json
			 FROM vector_full_scan('${TABLE}', 'embedding', ?) AS scan
			 JOIN ${TABLE} AS v ON v.rowid = scan.rowid
			 ${scoped.sql}
			 ORDER BY scan.distance ASC, v.id COLLATE BINARY ASC
			 LIMIT ?`,
			[vectorBytes(query), ...scoped.bind, limit],
		);
		return rows.map(decodeHit);
	}

	public async searchByIds(
		query: Float32Array,
		ids: ReadonlyArray<string>,
	): Promise<ReadonlyArray<VectorHit>> {
		this.#assertOpen();
		validateVector(query, this.dimension, "query");
		const unique = uniqueIds(ids);
		if (unique.length === 0) {
			return [];
		}
		if (unique.length <= DIRECT_ID_LOOKUP_THRESHOLD) {
			return this.#searchByIdsDirect(query, unique);
		}
		const hits: VectorHit[] = [];
		for (const idsChunk of chunks(unique, SQLITE_MAX_BIND_PARAMETERS - 1)) {
			const placeholders = idsChunk.map(() => "?").join(", ");
			const rows = this.#database.selectObjects(
				`SELECT v.id AS id, scan.distance AS distance, v.metadata_json AS metadata_json
				 FROM vector_full_scan('${TABLE}', 'embedding', ?) AS scan
				 JOIN ${TABLE} AS v ON v.rowid = scan.rowid
				 WHERE v.id IN (${placeholders})`,
				[vectorBytes(query), ...idsChunk],
			);
			hits.push(...rows.map(decodeHit));
		}
		hits.sort(compareHits);
		return hits;
	}

	public async delete(
		ids: ReadonlyArray<string>,
		filters?: Metadata,
	): Promise<number> {
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
		this.#database.exec(
			`DELETE FROM ${TABLE} WHERE id IN (${placeholders})${scoped.sql.replace("WHERE", " AND")}`,
			[...unique, ...scoped.bind],
		);
		const changed = requireFiniteNumber(
			this.#database.selectObjects("SELECT changes() AS changed")[0]?.changed,
			"SQLite delete count",
		);
		if (changed > 0) {
			this.#invalidateQuantize();
		}
		return changed;
	}

	public async deleteWhere(filters: Metadata): Promise<number> {
		this.#assertOpen();
		validateRequiredMetadata(filters, "filters");
		const scoped = filterClause(filters, TABLE);
		this.#database.exec(`DELETE FROM ${TABLE} ${scoped.sql}`, scoped.bind);
		const changed = changedRowCount(
			this.#database,
			"SQLite metadata delete count",
		);
		if (changed > 0) {
			this.#invalidateQuantize();
		}
		return changed;
	}

	public async clear(): Promise<number> {
		this.#assertOpen();
		this.#database.exec(`DELETE FROM ${TABLE}`);
		const changed = changedRowCount(this.#database, "SQLite clear count");
		this.#cleanupQuantize();
		return changed;
	}

	public async stats(filters?: Metadata): Promise<VectorStats> {
		this.#assertOpen();
		validateMetadata(filters, "filters");
		const scoped = filterClause(filters, "v");
		const count = requireFiniteNumber(
			this.#database.selectObjects(
				`SELECT COUNT(*) AS count FROM ${TABLE} AS v ${scoped.sql}`,
				scoped.bind,
			)[0]?.count,
			"SQLite vector count",
		);
		return {
			name: this.name,
			dimension: this.dimension,
			vectorCount: count,
			vectorBytes: count * this.dimension * Float32Array.BYTES_PER_ELEMENT,
		};
	}

	public runtimeInfo(): SqliteVectorRuntimeInfo {
		this.#assertOpen();
		const versions = this.#database.selectObjects(
			"SELECT sqlite_version() AS sqlite_version, vector_version() AS vector_version, vector_backend() AS vector_backend",
		)[0];
		if (versions === undefined) {
			throw new Error("SQLite runtime did not return version information");
		}
		const extensionRows = this.#database.selectObjects(
			"SELECT name FROM pragma_function_list WHERE name IN ('vector_version', 'sync_version', 'memory_version') ORDER BY name",
		);
		return {
			sqliteVersion: requireString(versions.sqlite_version, "SQLite version"),
			vectorVersion: requireString(
				versions.vector_version,
				"sqlite-vector version",
			),
			vectorBackend: requireString(
				versions.vector_backend,
				"sqlite-vector backend",
			),
			bundledExtensions: extensionRows.map((row) =>
				requireString(row.name, "SQLite extension name"),
			),
		};
	}

	public async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		this.#database.close();
	}

	#initialize(): void {
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
		this.#database.exec(
			`INSERT OR IGNORE INTO ${CONFIG_TABLE}(singleton, dimension) VALUES(1, ?)`,
			[this.dimension],
		);
		const storedDimension = requireFiniteNumber(
			this.#database.selectObjects(
				`SELECT dimension FROM ${CONFIG_TABLE} WHERE singleton = 1`,
			)[0]?.dimension,
			"stored vector dimension",
		);
		if (storedDimension !== this.dimension) {
			throw new Error(
				`vector index ${JSON.stringify(this.name)} has dimension ${storedDimension}; requested ${this.dimension}`,
			);
		}
		this.#database.selectObjects(
			`SELECT vector_init('${TABLE}', 'embedding', ?) AS initialized`,
			[
				`dimension=${this.dimension},type=FLOAT32,distance=COSINE,qtype=TURBOQUANT,qbits=4`,
			],
		);
	}

	#assertOpen(): void {
		if (this.#disposed) {
			throw new Error(`vector index ${JSON.stringify(this.name)} is disposed`);
		}
	}

	#unscopedRowCount(): number {
		return requireFiniteNumber(
			this.#database.selectObjects(`SELECT COUNT(*) AS count FROM ${TABLE}`)[0]
				?.count,
			"SQLite vector count",
		);
	}

	#invalidateQuantize(): void {
		this.#quantizeReady = false;
		this.#mutated = true;
	}

	#cleanupQuantize(): void {
		this.#quantizeReady = false;
		this.#mutated = true;
		this.#database.selectObjects(
			`SELECT vector_quantize_cleanup('${TABLE}', 'embedding')`,
		);
	}

	#ensureTurboQuant(rowCount: number): void {
		if (this.#quantizeReady) {
			return;
		}
		if (this.#mutated || !this.#hasQuantizedRows(rowCount)) {
			this.#database.selectObjects(
				`SELECT vector_quantize_cleanup('${TABLE}', 'embedding')`,
			);
			this.#database.selectObjects(
				`SELECT vector_quantize('${TABLE}', 'embedding')`,
			);
			this.#database.exec("PRAGMA shrink_memory");
			this.#mutated = false;
		}
		this.#quantizeReady = true;
	}

	#hasQuantizedRows(rowCount: number): boolean {
		const exists = this.#database.selectObjects(
			"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
			[QUANTIZE_TABLE],
		)[0];
		if (exists === undefined) {
			return false;
		}
		const quantizedCount = requireFiniteNumber(
			this.#database.selectObjects(
				`SELECT COALESCE(SUM(counter), 0) AS count FROM ${QUANTIZE_TABLE}`,
			)[0]?.count,
			"quantized vector count",
		);
		return quantizedCount === rowCount;
	}

	#trySearchTurboQuant(
		query: Float32Array,
		limit: number,
		rowCount: number,
	): ReadonlyArray<VectorHit> | undefined {
		try {
			this.#ensureTurboQuant(rowCount);
			const candidateLimit = Math.min(
				rowCount,
				Math.max(
					limit * TURBOQUANT_OVERSAMPLE_FACTOR,
					TURBOQUANT_MIN_CANDIDATES,
				),
			);
			const rows = this.#database.selectObjects(
				`SELECT v.id AS id, v.embedding AS embedding, v.metadata_json AS metadata_json
				 FROM vector_quantize_scan('${TABLE}', 'embedding', ?, ?) AS scan
				 JOIN ${TABLE} AS v ON v.rowid = scan.rowid`,
				[vectorBytes(query), candidateLimit],
			);
			const hits = rows.map((row) =>
				decodeRescoredHit(row, query, this.dimension),
			);
			hits.sort(compareHits);
			return hits.slice(0, limit);
		} catch {
			this.#cleanupQuantize();
			this.#database.exec("PRAGMA shrink_memory");
			return undefined;
		}
	}

	#searchByIdsDirect(
		query: Float32Array,
		unique: ReadonlyArray<string>,
	): ReadonlyArray<VectorHit> {
		const placeholders = unique.map(() => "?").join(", ");
		const rows = this.#database.selectObjects(
			`SELECT v.id AS id, v.embedding AS embedding, v.metadata_json AS metadata_json
			 FROM ${TABLE} AS v
			 WHERE v.id IN (${placeholders})`,
			unique,
		);
		const hits = rows.map((row) =>
			decodeRescoredHit(row, query, this.dimension),
		);
		hits.sort(compareHits);
		return hits;
	}

	#replaceRecords(records: ReadonlyArray<SqliteKeyedVectorRecord>): void {
		for (const run of distinctIdRuns(records, BATCH_INSERT_RUN_LIMIT)) {
			this.#replaceDistinctRun(run);
		}
	}

	#replaceDistinctRun(run: ReadonlyArray<SqliteKeyedVectorRecord>): void {
		const deletePlaceholders = run.map(() => "?").join(", ");
		this.#database.exec(
			`DELETE FROM ${TABLE} WHERE id IN (${deletePlaceholders})`,
			run.map((record) => record.id),
		);
		const vectorPlaceholders = run
			.map(() => "(?, vector_as_f32(?), ?)")
			.join(", ");
		const vectorBind: SqliteValue[] = [];
		const metadataRows: Array<
			readonly [string, string, string, string | null, number | null]
		> = [];
		const lookupRows: Array<readonly [string, string, string]> = [];
		for (const record of run) {
			vectorBind.push(
				record.id,
				vectorBytes(record.vector),
				JSON.stringify(record.metadata),
			);
			for (const [key, value] of Object.entries(record.metadata)) {
				const encoded = encodeScalar(value);
				metadataRows.push([
					record.id,
					key,
					encoded.kind,
					encoded.text,
					encoded.number,
				]);
			}
			for (const key of record.lookupKeys) {
				lookupRows.push([record.id, key.namespace, key.value]);
			}
		}
		this.#database.exec(
			`INSERT INTO ${TABLE}(id, embedding, metadata_json) VALUES ${vectorPlaceholders}`,
			vectorBind,
		);
		this.#insertMetadataRows(metadataRows);
		this.#insertLookupRows(lookupRows);
	}

	#insertMetadataRows(
		rows: ReadonlyArray<
			readonly [string, string, string, string | null, number | null]
		>,
	): void {
		const maxRows = Math.floor(SQLITE_MAX_BIND_PARAMETERS / 5);
		for (const chunk of chunks(rows, maxRows)) {
			const placeholders = chunk.map(() => "(?, ?, ?, ?, ?)").join(", ");
			const bind: SqliteValue[] = [];
			for (const [recordId, key, kind, text, num] of chunk) {
				bind.push(recordId, key, kind, text, num);
			}
			this.#database.exec(
				`INSERT INTO ${METADATA_TABLE}(record_id, key, kind, value_text, value_number) VALUES ${placeholders}`,
				bind,
			);
		}
	}

	#insertLookupRows(
		rows: ReadonlyArray<readonly [string, string, string]>,
	): void {
		const maxRows = Math.floor(SQLITE_MAX_BIND_PARAMETERS / 3);
		for (const chunk of chunks(rows, maxRows)) {
			const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
			const bind: SqliteValue[] = [];
			for (const [recordId, namespace, value] of chunk) {
				bind.push(recordId, namespace, value);
			}
			this.#database.exec(
				`INSERT INTO ${LOOKUP_TABLE}(record_id, namespace, lookup_key) VALUES ${placeholders}`,
				bind,
			);
		}
	}
}

interface EncodedScalar {
	readonly kind: string;
	readonly text: string | null;
	readonly number: number | null;
}

function encodeScalar(value: Scalar): EncodedScalar {
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

function filterClause(
	filters: Metadata | undefined,
	recordAlias: string,
): { readonly sql: string; readonly bind: ReadonlyArray<SqliteValue> } {
	if (filters === undefined || Object.keys(filters).length === 0) {
		return { sql: "", bind: [] };
	}
	const clauses: string[] = [];
	const bind: SqliteValue[] = [];
	let index = 0;
	for (const [key, value] of Object.entries(filters)) {
		const alias = `filter_${index}`;
		const encoded = encodeScalar(value);
		clauses.push(
			`EXISTS (SELECT 1 FROM ${METADATA_TABLE} AS ${alias} WHERE ${alias}.record_id = ${recordAlias}.id AND ${alias}.key = ? AND ${alias}.kind = ? AND ${alias}.value_text IS ? AND ${alias}.value_number IS ?)`,
		);
		bind.push(key, encoded.kind, encoded.text, encoded.number);
		index += 1;
	}
	return { sql: `WHERE ${clauses.join(" AND ")}`, bind };
}

function validateOptions(options: VectorIndexOptions): void {
	if (!Number.isInteger(options.dimension) || options.dimension < 1) {
		throw new RangeError("vector dimension must be an integer >= 1");
	}
	if (options.name.length === 0) {
		throw new TypeError("vector index name must not be empty");
	}
}

function validateAndCopyRecord(
	record: VectorRecord,
	dimension: number,
): VectorRecord {
	validateId(record.id);
	validateVector(
		record.vector,
		dimension,
		`record ${JSON.stringify(record.id)}`,
	);
	validateMetadata(
		record.metadata,
		`record ${JSON.stringify(record.id)} metadata`,
	);
	return {
		id: record.id,
		vector: record.vector.slice(),
		metadata: { ...record.metadata },
	};
}

function validateAndCopyKeyedRecord(
	record: SqliteKeyedVectorRecord,
	dimension: number,
): SqliteKeyedVectorRecord {
	const vectorRecord = validateAndCopyRecord(record, dimension);
	return {
		...vectorRecord,
		lookupKeys: uniqueLookupKeys(
			record.lookupKeys,
			`record ${JSON.stringify(record.id)} lookup keys`,
		),
	};
}

function uniqueLookupKeys(
	keys: ReadonlyArray<SqliteLookupKey>,
	at: string,
): ReadonlyArray<SqliteLookupKey> {
	if (!Array.isArray(keys)) {
		throw new TypeError(`${at} must be an array`);
	}
	const seen = new Set<string>();
	const unique: SqliteLookupKey[] = [];
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

function validateLookupKey(key: SqliteLookupKey, at: string): void {
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

function validateMaxDocumentFrequency(maxDocumentFrequency: number): void {
	if (!Number.isInteger(maxDocumentFrequency) || maxDocumentFrequency < 1) {
		throw new RangeError("maximum document frequency must be an integer >= 1");
	}
}

function validateId(id: string): void {
	if (typeof id !== "string" || id.length === 0) {
		throw new TypeError("vector record id must not be empty");
	}
}

function uniqueIds(ids: ReadonlyArray<string>): ReadonlyArray<string> {
	const unique = new Set<string>();
	for (const id of ids) {
		validateId(id);
		unique.add(id);
	}
	return [...unique];
}

function* chunks<T>(
	values: ReadonlyArray<T>,
	size: number,
): Generator<ReadonlyArray<T>> {
	for (let start = 0; start < values.length; start += size) {
		yield values.slice(start, start + size);
	}
}

function validateVector(
	vector: Float32Array,
	dimension: number,
	at: string,
): void {
	if (!(vector instanceof Float32Array)) {
		throw new TypeError(`${at} must be a Float32Array`);
	}
	if (vector.length !== dimension) {
		throw new RangeError(
			`${at} has dimension ${vector.length}; expected ${dimension}`,
		);
	}
	for (const value of vector) {
		if (!Number.isFinite(value)) {
			throw new TypeError(`${at} contains a non-finite value`);
		}
	}
}

function validateLimit(limit: number): void {
	if (!Number.isInteger(limit) || limit < 0) {
		throw new RangeError("search limit must be a non-negative integer");
	}
}

function validateMetadata(metadata: Metadata | undefined, at: string): void {
	if (metadata === undefined) {
		return;
	}
	for (const [key, value] of Object.entries(metadata)) {
		if (key.length === 0) {
			throw new TypeError(`${at} contains an empty key`);
		}
		if (
			value !== null &&
			typeof value !== "string" &&
			typeof value !== "number" &&
			typeof value !== "boolean"
		) {
			throw new TypeError(`${at}.${key} must be a scalar`);
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			throw new TypeError(`${at}.${key} must be finite`);
		}
	}
}

function validateRequiredMetadata(metadata: Metadata, at: string): void {
	validateMetadata(metadata, at);
	if (Object.keys(metadata).length === 0) {
		throw new TypeError(`${at} must contain at least one filter`);
	}
}

function changedRowCount(database: SqliteDatabase, at: string): number {
	return requireFiniteNumber(
		database.selectObjects("SELECT changes() AS changed")[0]?.changed,
		at,
	);
}

function vectorBytes(vector: Float32Array): Uint8Array {
	return new Uint8Array(vector.slice().buffer);
}

function decodeRecord(
	row: Readonly<Record<string, unknown>>,
	dimension: number,
): VectorRecord {
	const bytes = row.embedding;
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError("SQLite returned a non-BLOB embedding");
	}
	const copy = bytes.slice();
	const vector = new Float32Array(
		copy.buffer,
		copy.byteOffset,
		copy.byteLength / 4,
	);
	validateVector(vector, dimension, "stored vector");
	return {
		id: requireString(row.id, "stored vector id"),
		vector,
		metadata: decodeMetadata(row.metadata_json),
	};
}

function decodeHit(row: Readonly<Record<string, unknown>>): VectorHit {
	return {
		id: requireString(row.id, "search result id"),
		distance: requireFiniteNumber(row.distance, "search result distance"),
		metadata: decodeMetadata(row.metadata_json),
	};
}

function decodeRescoredHit(
	row: Readonly<Record<string, unknown>>,
	query: Float32Array,
	dimension: number,
): VectorHit {
	return {
		id: requireString(row.id, "search result id"),
		distance: cosineDistanceF32(query, row.embedding, dimension),
		metadata: decodeMetadata(row.metadata_json),
	};
}

function cosineDistanceF32(
	query: Float32Array,
	embeddingBytes: unknown,
	dimension: number,
): number {
	const candidate = decodeEmbeddingView(embeddingBytes, dimension);
	let dot = 0;
	let queryNorm = 0;
	let candidateNorm = 0;
	for (let index = 0; index < dimension; index += 1) {
		const q = query[index] ?? 0;
		const c = candidate[index] ?? 0;
		dot = Math.fround(dot + Math.fround(q * c));
		queryNorm = Math.fround(queryNorm + Math.fround(q * q));
		candidateNorm = Math.fround(candidateNorm + Math.fround(c * c));
	}
	const denominator = Math.fround(
		Math.fround(Math.sqrt(queryNorm)) * Math.fround(Math.sqrt(candidateNorm)),
	);
	if (denominator === 0) {
		return 1;
	}
	return Math.max(0, Math.fround(1 - Math.fround(dot / denominator)));
}

function decodeEmbeddingView(bytes: unknown, dimension: number): Float32Array {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError("SQLite returned a non-BLOB embedding");
	}
	if (bytes.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
		throw new RangeError(
			`stored vector has ${bytes.byteLength} bytes; expected ${dimension * Float32Array.BYTES_PER_ELEMENT}`,
		);
	}
	if (bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT === 0) {
		return new Float32Array(bytes.buffer, bytes.byteOffset, dimension);
	}
	const aligned = bytes.slice();
	return new Float32Array(aligned.buffer, aligned.byteOffset, dimension);
}

function compareHits(left: VectorHit, right: VectorHit): number {
	return left.distance - right.distance || compareCodeUnits(left.id, right.id);
}

function distinctIdRuns(
	records: ReadonlyArray<SqliteKeyedVectorRecord>,
	maxRecordsPerRun: number,
): ReadonlyArray<ReadonlyArray<SqliteKeyedVectorRecord>> {
	const runs: SqliteKeyedVectorRecord[][] = [];
	let current: SqliteKeyedVectorRecord[] = [];
	let seen = new Set<string>();
	for (const record of records) {
		if (seen.has(record.id) || current.length >= maxRecordsPerRun) {
			runs.push(current);
			current = [];
			seen = new Set<string>();
		}
		seen.add(record.id);
		current.push(record);
	}
	if (current.length > 0) {
		runs.push(current);
	}
	return runs;
}

function decodeMetadata(value: unknown): Metadata {
	const json = requireString(value, "stored metadata");
	const parsed: unknown = JSON.parse(json);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError("stored metadata is not an object");
	}
	const metadata = parsed as Record<string, Scalar>;
	validateMetadata(metadata, "stored metadata");
	return { ...metadata };
}

function requireString(value: unknown, at: string): string {
	if (typeof value !== "string") {
		throw new TypeError(`${at} was not a string`);
	}
	return value;
}

function requireFiniteNumber(value: unknown, at: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${at} was not a finite number`);
	}
	return value;
}

function compareCodeUnits(left: string, right: string): number {
	if (left === right) {
		return 0;
	}
	return left < right ? -1 : 1;
}
