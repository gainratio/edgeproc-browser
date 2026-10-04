// Main-thread proxy for the library's SQL Worker. Every call is one message;
// the Worker runs them one at a time on a single SQLite connection.

import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";
import {
	type SqlBind,
	type SqlDatabaseOptions,
	type SqlExecResult,
	type SqlImportOptions,
	SqlImportRejectedError,
	type SqlImportResult,
	type SqlRow,
	type SqlRuntimeInfo,
	type SqlStatement,
	type SqlStorage,
	SqlStorageUnavailableError,
	type SqlTransactionResult,
} from "./types.js";

export interface SqlWorkerLike {
	postMessage(message: SqlWorkerRequest): void;
	terminate(): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<SqlWorkerResponse>) => void,
	): void;
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
	addEventListener(
		type: "messageerror",
		listener: (event: MessageEvent<unknown>) => void,
	): void;
}

export type SqlWorkerFactory = () => SqlWorkerLike;

/** A statement compiled once in the Worker and run many times. */
export interface SqlPreparedStatement {
	run(bind?: SqlBind): Promise<SqlExecResult>;
	all<R extends SqlRow = SqlRow>(bind?: SqlBind): Promise<R[]>;
	finalize(): Promise<void>;
}

export interface SqlDatabase {
	readonly name: string;
	/** Where the database actually lives — OPFS, or memory and why. */
	readonly storage: SqlStorage;
	/** Run one or more statements (bind applies to the first). */
	exec(sql: string, bind?: SqlBind): Promise<SqlExecResult>;
	/** Rows of a single statement. */
	query<R extends SqlRow = SqlRow>(sql: string, bind?: SqlBind): Promise<R[]>;
	/** All statements in one BEGIN IMMEDIATE … COMMIT; any failure rolls back all. */
	transaction(
		statements: ReadonlyArray<SqlStatement>,
	): Promise<SqlTransactionResult>;
	/** Bulk load: prepare once, step per row, one transaction. */
	executeMany(
		sql: string,
		rows: ReadonlyArray<SqlBind>,
	): Promise<SqlExecResult>;
	prepare(sql: string): Promise<SqlPreparedStatement>;
	/** The whole database as a SQLite file (sqlite3_serialize). */
	exportDatabase(): Promise<Uint8Array>;
	/**
	 * Validate `bytes` (header, integrity_check, your expectations), then
	 * replace this database with it in one transaction. On any failure the
	 * database is unchanged.
	 */
	importDatabase(
		bytes: Uint8Array,
		options?: SqlImportOptions,
	): Promise<SqlImportResult>;
	runtimeInfo(): Promise<SqlRuntimeInfo>;
	/** Close the connection, release the OPFS pool and end the Worker. */
	close(): Promise<void>;
}

export interface OpenSqlDatabaseOptions {
	readonly workerFactory?: SqlWorkerFactory;
}

type Pending = {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
};

type RequestWithoutId = SqlWorkerRequest extends infer Request
	? Request extends { readonly id: number }
		? Omit<Request, "id">
		: never
	: never;

/**
 * Open a named SQLite database in the library's Worker: OPFS (opfs-sahpool)
 * with the device memory profile applied, FTS5, JSON1 and sqlite-vector on the
 * same connection. Check `storage` to see whether it fell back to memory.
 */
export async function openSqlDatabase(
	options: SqlDatabaseOptions,
	{ workerFactory = defaultWorkerFactory }: OpenSqlDatabaseOptions = {},
): Promise<SqlDatabase> {
	const connection = new Connection(workerFactory());
	try {
		const storage = (await connection.request({
			operation: "open",
			options,
		})) as SqlStorage;
		return new WorkerSqlDatabase(options.name, storage, connection);
	} catch (error) {
		connection.terminate(error as Error);
		throw error;
	}
}

class Connection {
	readonly #worker: SqlWorkerLike;
	readonly #pending = new Map<number, Pending>();
	#nextId = 1;
	#terminal: Error | undefined;

	public constructor(worker: SqlWorkerLike) {
		this.#worker = worker;
		worker.addEventListener("message", (event) => this.#receive(event.data));
		worker.addEventListener("error", (event) =>
			this.terminate(new Error(`SQL worker failed: ${event.message}`)),
		);
		worker.addEventListener("messageerror", () =>
			this.terminate(new Error("SQL worker returned an unreadable message")),
		);
	}

	public request(request: RequestWithoutId): Promise<unknown> {
		if (this.#terminal !== undefined) return Promise.reject(this.#terminal);
		const id = this.#nextId++;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#worker.postMessage({ ...request, id } as SqlWorkerRequest);
		});
	}

	public terminate(error: Error): void {
		this.#terminal ??= error;
		this.#worker.terminate();
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#receive(response: SqlWorkerResponse): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) return;
		this.#pending.delete(response.id);
		if (response.ok) pending.resolve(response.value);
		else pending.reject(reconstructError(response.error));
	}
}

class WorkerSqlDatabase implements SqlDatabase {
	public readonly name: string;
	public readonly storage: SqlStorage;
	readonly #connection: Connection;
	#closed = false;

	public constructor(
		name: string,
		storage: SqlStorage,
		connection: Connection,
	) {
		this.name = name;
		this.storage = storage;
		this.#connection = connection;
	}

	public exec(sql: string, bind?: SqlBind): Promise<SqlExecResult> {
		return this.#call({ operation: "exec", sql, ...withBind(bind) });
	}

	public query<R extends SqlRow = SqlRow>(
		sql: string,
		bind?: SqlBind,
	): Promise<R[]> {
		return this.#call({ operation: "query", sql, ...withBind(bind) });
	}

	public transaction(
		statements: ReadonlyArray<SqlStatement>,
	): Promise<SqlTransactionResult> {
		return this.#call({ operation: "transaction", statements });
	}

	public executeMany(
		sql: string,
		rows: ReadonlyArray<SqlBind>,
	): Promise<SqlExecResult> {
		return this.#call({ operation: "execute-many", sql, rows });
	}

	public async prepare(sql: string): Promise<SqlPreparedStatement> {
		const statement = await this.#call<number>({ operation: "prepare", sql });
		return {
			run: (bind) =>
				this.#call({ operation: "run-prepared", statement, ...withBind(bind) }),
			all: (bind) =>
				this.#call({ operation: "all-prepared", statement, ...withBind(bind) }),
			finalize: () => this.#call({ operation: "finalize", statement }),
		};
	}

	public exportDatabase(): Promise<Uint8Array> {
		return this.#call({ operation: "export" });
	}

	public importDatabase(
		bytes: Uint8Array,
		options?: SqlImportOptions,
	): Promise<SqlImportResult> {
		return this.#call({
			operation: "import",
			bytes,
			...(options === undefined ? {} : { options }),
		});
	}

	public runtimeInfo(): Promise<SqlRuntimeInfo> {
		return this.#call({ operation: "runtime-info" });
	}

	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#connection.request({ operation: "close" });
		} finally {
			this.#connection.terminate(new Error("SQL database is closed"));
		}
	}

	#call<T>(request: RequestWithoutId): Promise<T> {
		if (this.#closed) {
			return Promise.reject(new Error("SQL database is closed"));
		}
		return this.#connection.request(request) as Promise<T>;
	}
}

/**
 * Export a database: an open handle, or a name — opened on OPFS (never a
 * memory fallback) under its owner lock, exported, closed.
 */
export async function exportDatabase(
	target: SqlDatabase | string,
	options: OpenSqlDatabaseOptions = {},
): Promise<Uint8Array> {
	return withDatabase(target, options, (db) => db.exportDatabase());
}

/**
 * Replace a database with `bytes`: an open handle, or a name. By name it is
 * opened on OPFS under the owner Web Lock, so no other tab or Worker can
 * write while the import runs; if one already has it open, this fails
 * closed with {@link SqlStorageUnavailableError} ("pool-in-use").
 */
export async function importDatabase(
	target: SqlDatabase | string,
	bytes: Uint8Array,
	options: SqlImportOptions & OpenSqlDatabaseOptions = {},
): Promise<SqlImportResult> {
	const { workerFactory, ...importOptions } = options;
	return withDatabase(
		target,
		workerFactory === undefined ? {} : { workerFactory },
		(db) => db.importDatabase(bytes, importOptions),
	);
}

async function withDatabase<T>(
	target: SqlDatabase | string,
	options: OpenSqlDatabaseOptions,
	action: (db: SqlDatabase) => Promise<T>,
): Promise<T> {
	if (typeof target !== "string") return action(target);
	const db = await openSqlDatabase(
		{ name: target, persistence: "opfs", fallback: "none" },
		options,
	);
	try {
		return await action(db);
	} finally {
		await db.close();
	}
}

function withBind(bind: SqlBind | undefined): { readonly bind?: SqlBind } {
	return bind === undefined ? {} : { bind };
}

function reconstructError(error: {
	readonly name: string;
	readonly message: string;
	readonly reason?: SqlStorageUnavailableError["reason"];
	readonly rejection?: SqlImportRejectedError["reason"];
}): Error {
	if (
		error.name === "SqlImportRejectedError" &&
		error.rejection !== undefined
	) {
		return new SqlImportRejectedError(error.rejection, error.message);
	}
	if (
		error.name === "SqlStorageUnavailableError" &&
		error.reason !== undefined
	) {
		return new SqlStorageUnavailableError(error.reason, error.message);
	}
	const reconstructed = new Error(error.message);
	reconstructed.name = error.name;
	return reconstructed;
}

function defaultWorkerFactory(): SqlWorkerLike {
	return new Worker(new URL("./worker.js", import.meta.url), {
		type: "module",
		name: "edgeproc-sql",
	});
}
