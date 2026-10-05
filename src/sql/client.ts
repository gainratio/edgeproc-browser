// Main-thread proxy for the library's SQL Worker. Every call is one message;
// the Worker runs them one at a time on a single SQLite connection.

import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";
import {
	type LegacySahPoolMigration,
	type MigrateLegacySahPoolOptions,
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
	SqlTransactionEndedError,
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

/**
 * The handle an interactive transaction's callback gets. Its calls run inside
 * the transaction; the handle stops working once the callback settles.
 */
export interface SqlTransaction {
	exec(sql: string, bind?: SqlBind): Promise<SqlExecResult>;
	query<R extends SqlRow = SqlRow>(sql: string, bind?: SqlBind): Promise<R[]>;
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
	/**
	 * Interactive: BEGIN IMMEDIATE, run `work` (read, decide in JS, write
	 * through `tx`), COMMIT; a throw or a failed COMMIT rolls back and rejects
	 * with that error. Every other call on this handle waits until it ends, so
	 * nothing interleaves. Inside `work`, use `tx` — awaiting a call on `db`
	 * there waits for the transaction it is part of, and never resolves.
	 */
	transaction<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
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
	/**
	 * Move a database another build kept in an opfs-sahpool into this one:
	 * hold that pool exclusively, let SQLite recover a hot journal, import the
	 * result atomically (as {@link importDatabase}), then remove the legacy
	 * pool only if you asked. Browser Worker on OPFS only.
	 */
	migrateLegacySahPool(
		options: MigrateLegacySahPoolOptions,
	): Promise<LegacySahPoolMigration>;
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
	openOptions: OpenSqlDatabaseOptions = {},
): Promise<SqlDatabase> {
	return openInWorker(options, openOptions, false);
}

async function openInWorker(
	options: SqlDatabaseOptions,
	{ workerFactory = defaultWorkerFactory }: OpenSqlDatabaseOptions,
	transient: boolean,
): Promise<SqlDatabase> {
	const connection = new Connection(workerFactory());
	try {
		const storage = (await connection.request({
			operation: "open",
			options,
			...(transient ? { transient: true as const } : {}),
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
	/** Settles when every call queued so far has been posted or finished. */
	#tail: Promise<void> = Promise.resolve();
	/** Transactions queued or running. */
	#exclusiveCount = 0;
	/** Cancels for calls waiting behind a transaction (close() fires them). */
	readonly #waiting = new Set<(error: Error) => void>();
	#activeTransaction: ScopedTransaction | undefined;

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
	): Promise<SqlTransactionResult>;
	public transaction<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T>;
	public transaction<T>(
		input: ReadonlyArray<SqlStatement> | ((tx: SqlTransaction) => Promise<T>),
	): Promise<SqlTransactionResult | T> {
		if (typeof input !== "function") {
			return this.#call({ operation: "transaction", statements: input });
		}
		if (this.#closed) {
			return Promise.reject(new Error("SQL database is closed"));
		}
		return this.#exclusive(() => this.#interactive(input));
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

	public migrateLegacySahPool(
		options: MigrateLegacySahPoolOptions,
	): Promise<LegacySahPoolMigration> {
		return this.#call({ operation: "migrate-legacy", options });
	}

	public runtimeInfo(): Promise<SqlRuntimeInfo> {
		return this.#call({ operation: "runtime-info" });
	}

	/**
	 * Close now: calls waiting behind a transaction fail, an open interactive
	 * transaction is rolled back (its callback's calls then fail), the
	 * connection closes and the Worker ends. Never waits on user code.
	 */
	public async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const cancel of this.#waiting) cancel(closedError());
		this.#waiting.clear();
		const open = this.#activeTransaction;
		open?.end("closed");
		try {
			if (open !== undefined) {
				await this.#connection.request({ operation: "rollback" });
			}
		} finally {
			try {
				await this.#connection.request({ operation: "close" });
			} finally {
				this.#connection.terminate(closedError());
			}
		}
	}

	#call<T>(request: RequestWithoutId): Promise<T> {
		if (this.#closed) return Promise.reject(closedError());
		// No transaction queued or open: post now, so the arguments are copied
		// at the call (as postMessage does) and plain calls pipeline.
		if (this.#exclusiveCount === 0) {
			return this.#connection.request(request) as Promise<T>;
		}
		// Otherwise wait for it to end, holding a copy taken now; close()
		// fails the wait instead of leaving it queued behind user code.
		const snapshot = structuredClone(request);
		return new Promise<T>((resolve, reject) => {
			this.#waiting.add(reject);
			void this.#tail.then(() => {
				if (!this.#waiting.delete(reject)) return;
				(this.#connection.request(snapshot) as Promise<T>).then(
					resolve,
					reject,
				);
			});
		});
	}

	/** Run `action` alone: later calls wait until it settles. */
	#exclusive<T>(action: () => Promise<T>): Promise<T> {
		this.#exclusiveCount += 1;
		const run = this.#tail.then(action);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		void this.#tail.then(() => {
			this.#exclusiveCount -= 1;
		});
		return run;
	}

	async #interactive<T>(work: (tx: SqlTransaction) => Promise<T>): Promise<T> {
		if (this.#closed) throw closedError();
		const send = (request: RequestWithoutId) =>
			this.#connection.request(request);
		const tx = new ScopedTransaction(send);
		this.#activeTransaction = tx;
		try {
			await send({ operation: "begin" });
			// close() settles this even if the callback never does.
			const value = await Promise.race([work(tx), tx.whenClosed]);
			if (tx.closed) throw closedError();
			await send({ operation: "commit" });
			return value;
		} catch (error) {
			// close() already rolled it back and ended the connection.
			if (tx.closed) throw closedError();
			try {
				await send({ operation: "rollback" });
			} catch (rollbackError) {
				throw new AggregateError(
					[error, rollbackError],
					"SQL transaction failed and could not be rolled back",
				);
			}
			throw error;
		} finally {
			tx.end("finished");
			this.#activeTransaction = undefined;
		}
	}
}

function closedError(): Error {
	return new Error("SQL database is closed");
}

class ScopedTransaction implements SqlTransaction {
	readonly #send: (request: RequestWithoutId) => Promise<unknown>;
	#ended: "finished" | "closed" | undefined;
	#rejectClosed: (error: Error) => void = () => undefined;
	/** Rejects when close() ends the transaction; never resolves. */
	public readonly whenClosed = new Promise<never>((_resolve, reject) => {
		this.#rejectClosed = reject;
	});

	public constructor(send: (request: RequestWithoutId) => Promise<unknown>) {
		this.#send = send;
		this.whenClosed.catch(() => undefined);
	}

	public exec(sql: string, bind?: SqlBind): Promise<SqlExecResult> {
		return this.#run({ operation: "tx-exec", sql, ...withBind(bind) });
	}

	public query<R extends SqlRow = SqlRow>(
		sql: string,
		bind?: SqlBind,
	): Promise<R[]> {
		return this.#run({ operation: "tx-query", sql, ...withBind(bind) });
	}

	/** Did close() end it (rolled back), rather than the callback settling? */
	public get closed(): boolean {
		return this.#ended === "closed";
	}

	public end(reason: "finished" | "closed"): void {
		this.#ended ??= reason;
		if (this.#ended === "closed") this.#rejectClosed(closedError());
	}

	#run<T>(request: RequestWithoutId): Promise<T> {
		if (this.#ended === "closed") return Promise.reject(closedError());
		if (this.#ended !== undefined) {
			return Promise.reject(new Error("SQL transaction has ended"));
		}
		return this.#send(request) as Promise<T>;
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

/**
 * Move a legacy opfs-sahpool database into `to` (an open handle, or a name
 * opened on OPFS under its owner lock, never a memory fallback). See
 * {@link SqlDatabase.migrateLegacySahPool}.
 */
export async function migrateLegacySahPool(
	options: MigrateLegacySahPoolOptions & {
		readonly to: SqlDatabase | string;
	},
	openOptions: OpenSqlDatabaseOptions = {},
): Promise<LegacySahPoolMigration> {
	const { to, ...request } = options;
	return withDatabase(to, openOptions, (db) =>
		db.migrateLegacySahPool(request),
	);
}

async function withDatabase<T>(
	target: SqlDatabase | string,
	options: OpenSqlDatabaseOptions,
	action: (db: SqlDatabase) => Promise<T>,
): Promise<T> {
	if (typeof target !== "string") return action(target);
	const db = await openInWorker(
		{ name: target, persistence: "opfs", fallback: "none" },
		options,
		true,
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
	if (error.name === "SqlTransactionEndedError") {
		return new SqlTransactionEndedError(error.message);
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
