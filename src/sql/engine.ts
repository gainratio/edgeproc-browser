// The SQL engine that runs INSIDE the Worker, on the official sqlite-wasm OO1
// API. It owns one connection to the pinned build (SQLite 3.53.4 compiled with
// FTS5 and JSON1, plus sqlite-vector 1.1.2), so one database can hold rows, an
// FTS5 index and vectors and join them in one query. Nothing here re-implements
// SQL: every call is a prepared statement on that connection.

import {
	applyMemoryProfile,
	type MemoryProfile,
	readMemoryProfile,
} from "../sqlite/memoryProfile.js";
import { exportDatabase, importDatabase } from "./portable.js";
import type { SqlSerializer } from "./serializer.js";
import type {
	SqlBind,
	SqlBindValue,
	SqlExecResult,
	SqlImportOptions,
	SqlImportResult,
	SqlRow,
	SqlRuntimeInfo,
	SqlStatement,
	SqlStorage,
	SqlTransactionResult,
} from "./types.js";

export const PINNED_SQLITE_VERSION = "3.53.4";
export const PINNED_VECTOR_VERSION = "1.1.2";

type RawBind = ReadonlyArray<unknown> | Readonly<Record<string, unknown>>;

/** The slice of an OO1 prepared statement the engine uses. */
export interface SqlRawStatement {
	bind(values: RawBind): unknown;
	step(): boolean;
	get(target: Record<string, unknown>): Record<string, unknown>;
	reset(clearBindings?: boolean): unknown;
	finalize(): unknown;
}

/** The slice of an OO1 database handle the engine uses. */
export interface SqlRawDatabase {
	/** The native sqlite3* handle (sqlite-wasm OO1 exposes it). */
	readonly pointer?: number | bigint;
	exec(options: { readonly sql: string; readonly bind?: RawBind }): unknown;
	selectObjects(sql: string, bind?: RawBind): Array<Record<string, unknown>>;
	prepare(sql: string): SqlRawStatement;
	transaction<T>(qualifier: "IMMEDIATE", callback: () => T): T;
	close(): void;
}

export interface SqlEngineOptions {
	readonly storage: SqlStorage;
	readonly memoryProfile: MemoryProfile;
	/** SQLite's own (de)serialization; required for export and import. */
	readonly serializer?: SqlSerializer;
}

export class SqlEngine {
	readonly #raw: SqlRawDatabase;
	readonly #storage: SqlStorage;
	readonly #serializer: SqlSerializer | undefined;
	readonly #statements = new Map<number, SqlRawStatement>();
	#nextStatement = 1;

	public constructor(raw: SqlRawDatabase, options: SqlEngineOptions) {
		this.#raw = raw;
		this.#storage = options.storage;
		this.#serializer = options.serializer;
		assertPinnedRuntime(raw);
		applyMemoryProfile(profileHandle(raw), options.memoryProfile);
		if (options.storage.persistence === "opfs") applyPrivacyPragmas(raw);
	}

	public exec(sql: string, bind?: SqlBind): SqlExecResult {
		return this.#counting(() =>
			this.#raw.exec(
				bind === undefined ? { sql } : { sql, bind: normalizeBind(bind) },
			),
		).result;
	}

	public query(sql: string, bind?: SqlBind): SqlRow[] {
		const statement = this.#raw.prepare(sql);
		try {
			return collect(statement, bind);
		} finally {
			statement.finalize();
		}
	}

	public transaction(
		statements: ReadonlyArray<SqlStatement>,
	): SqlTransactionResult {
		const { value, result } = this.#counting(() =>
			this.#raw.transaction("IMMEDIATE", () =>
				statements.map((statement) => this.#runInTransaction(statement)),
			),
		);
		return { changes: result.changes, results: value };
	}

	public executeMany(sql: string, rows: ReadonlyArray<SqlBind>): SqlExecResult {
		return this.#counting(() =>
			this.#raw.transaction("IMMEDIATE", () =>
				this.#runInTransaction({ sql, rows }),
			),
		).result;
	}

	public prepare(sql: string): number {
		const id = this.#nextStatement++;
		this.#statements.set(id, this.#raw.prepare(sql));
		return id;
	}

	public runPrepared(id: number, bind?: SqlBind): SqlExecResult {
		const statement = this.#prepared(id);
		return this.#counting(() => collect(statement, bind)).result;
	}

	public allPrepared(id: number, bind?: SqlBind): SqlRow[] {
		return collect(this.#prepared(id), bind);
	}

	public finalize(id: number): void {
		this.#prepared(id).finalize();
		this.#statements.delete(id);
	}

	/** Start an interactive transaction; the client holds its lock until it ends. */
	public begin(): void {
		this.#raw.exec({ sql: "BEGIN IMMEDIATE" });
	}

	public commit(): void {
		this.#raw.exec({ sql: "COMMIT" });
	}

	/** Roll back; a no-op when SQLite already ended the transaction itself. */
	public rollback(): void {
		try {
			this.#raw.exec({ sql: "ROLLBACK" });
		} catch (error) {
			if (!/no transaction is active/.test(describeError(error))) throw error;
		}
	}

	/** The whole database as a SQLite file (sqlite3_serialize). */
	public exportDatabase(): Uint8Array {
		return exportDatabase(this.#raw, this.#requireSerializer());
	}

	/** Validate `bytes`, then replace this database with it in one transaction. */
	public importDatabase(
		bytes: Uint8Array,
		options?: SqlImportOptions,
	): SqlImportResult {
		return importDatabase(this.#raw, this.#requireSerializer(), bytes, options);
	}

	public runtimeInfo(): SqlRuntimeInfo {
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

	public close(): void {
		for (const statement of this.#statements.values()) statement.finalize();
		this.#statements.clear();
		this.#raw.close();
	}

	#runInTransaction(statement: SqlStatement): SqlRow[] {
		const prepared = this.#raw.prepare(statement.sql);
		try {
			if ("rows" in statement) {
				for (const row of statement.rows) collect(prepared, row);
				return [];
			}
			return collect(prepared, statement.bind);
		} finally {
			prepared.finalize();
		}
	}

	#requireSerializer(): SqlSerializer {
		if (this.#serializer === undefined) {
			throw new Error("this SQL engine was opened without a serializer");
		}
		return this.#serializer;
	}

	#prepared(id: number): SqlRawStatement {
		const statement = this.#statements.get(id);
		if (statement === undefined) {
			throw new Error(`prepared statement ${id} is not open`);
		}
		return statement;
	}

	#counting<T>(action: () => T): { value: T; result: SqlExecResult } {
		const before = totalChanges(this.#raw);
		const value = action();
		const row = this.#raw.selectObjects(
			"SELECT total_changes() AS total, last_insert_rowid() AS rowid",
		)[0];
		return {
			value,
			result: {
				changes: Number(row?.total) - before,
				lastInsertRowid: row?.rowid as number | bigint,
			},
		};
	}
}

function collect(statement: SqlRawStatement, bind?: SqlBind): SqlRow[] {
	try {
		if (bind !== undefined) statement.bind(normalizeBind(bind));
		const rows: SqlRow[] = [];
		while (statement.step()) rows.push(statement.get({}) as SqlRow);
		return rows;
	} finally {
		statement.reset(true);
	}
}

function normalizeBind(bind: SqlBind): RawBind {
	if (Array.isArray(bind)) return bind.map(normalizeValue);
	return Object.fromEntries(
		Object.entries(bind).map(([key, value]) => [key, normalizeValue(value)]),
	);
}

/** Bind any typed array as its raw bytes — the BLOB layout sqlite-vector reads. */
function normalizeValue(value: SqlBindValue): unknown {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return value;
}

function profileHandle(raw: SqlRawDatabase) {
	return {
		exec: (sql: string) => {
			raw.exec({ sql });
		},
		selectObjects: (sql: string) => raw.selectObjects(sql),
	};
}

function totalChanges(raw: SqlRawDatabase): number {
	return Number(raw.selectObjects("SELECT total_changes() AS total")[0]?.total);
}

function pinnedVersions(
	raw: SqlRawDatabase,
): Record<string, unknown> | undefined {
	return raw.selectObjects(
		"SELECT sqlite_version() AS sqlite, vector_version() AS vector, sqlite_compileoption_used('ENABLE_FTS5') AS fts5",
	)[0];
}

/** Refuse any build other than the pinned one: FTS5 and vectors must be there. */
function assertPinnedRuntime(raw: SqlRawDatabase): void {
	const row = pinnedVersions(raw);
	if (
		row?.sqlite !== PINNED_SQLITE_VERSION ||
		row.vector !== PINNED_VECTOR_VERSION ||
		row.fts5 !== 1
	) {
		throw new Error(`unexpected SQLite runtime: ${JSON.stringify(row)}`);
	}
}

/** Deleted rows are zeroed and no rollback journal outlives a transaction. */
function applyPrivacyPragmas(raw: SqlRawDatabase): void {
	raw.exec({ sql: "PRAGMA secure_delete = ON" });
	const journal = raw.selectObjects("PRAGMA journal_mode = DELETE")[0]
		?.journal_mode;
	const secureDelete = raw.selectObjects("PRAGMA secure_delete")[0]
		?.secure_delete;
	if (journal !== "delete" || secureDelete !== 1) {
		throw new Error("persistent SQLite privacy pragmas were not applied");
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
