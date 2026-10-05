// The Worker side of the protocol, free of Worker globals so it can be driven
// in-process by tests. Requests run strictly one at a time, in arrival order.

import type { SqlEngine } from "./engine.js";
import type {
	SqlWorkerError,
	SqlWorkerRequest,
	SqlWorkerResponse,
} from "./protocol.js";
import {
	type LegacySahPoolMigration,
	type MigrateLegacySahPoolOptions,
	type SqlDatabaseOptions,
	SqlImportRejectedError,
	SqlStorageUnavailableError,
} from "./types.js";

export interface OpenedSqlEngine {
	readonly engine: SqlEngine;
	/** Release whatever the open acquired (the OPFS owner lock); resolves once free. */
	release(): Promise<void>;
	/** Only a browser Worker (OPFS) can read a legacy opfs-sahpool. */
	migrateLegacy?(
		options: MigrateLegacySahPoolOptions,
	): Promise<LegacySahPoolMigration>;
}

export type SqlEngineOpener = (
	options: SqlDatabaseOptions,
	context: { readonly transient: boolean },
) => Promise<OpenedSqlEngine>;

export function createSqlWorkerHandler(
	open: SqlEngineOpener,
): (request: SqlWorkerRequest) => Promise<SqlWorkerResponse> {
	let current: OpenedSqlEngine | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	const dispatch = async (request: SqlWorkerRequest): Promise<unknown> => {
		if (request.operation === "open") {
			if (current !== undefined) {
				throw new Error("SQL worker already has an open database");
			}
			current = await open(request.options, {
				transient: request.transient === true,
			});
			return current.engine.runtimeInfo().storage;
		}
		if (current === undefined)
			throw new Error("SQL worker has no open database");
		const { engine } = current;
		switch (request.operation) {
			case "exec":
				return engine.exec(request.sql, request.bind);
			case "query":
				return engine.query(request.sql, request.bind);
			case "transaction":
				return engine.transaction(request.statements);
			case "execute-many":
				return engine.executeMany(request.sql, request.rows);
			case "begin":
				return engine.begin();
			case "tx-exec":
				return engine.txExec(request.sql, request.bind);
			case "tx-query":
				return engine.txQuery(request.sql, request.bind);
			case "commit":
				return engine.commit();
			case "rollback":
				return engine.rollback();
			case "prepare":
				return engine.prepare(request.sql);
			case "run-prepared":
				return engine.runPrepared(request.statement, request.bind);
			case "all-prepared":
				return engine.allPrepared(request.statement, request.bind);
			case "finalize":
				return engine.finalize(request.statement);
			case "export":
				return engine.exportDatabase();
			case "import":
				return engine.importDatabase(request.bytes, request.options);
			case "migrate-legacy":
				if (current.migrateLegacy === undefined) {
					throw new Error(
						"legacy opfs-sahpool migration needs the browser SQL Worker (OPFS)",
					);
				}
				return current.migrateLegacy(request.options);
			case "runtime-info":
				return engine.runtimeInfo();
			case "close": {
				const closing = current;
				current = undefined;
				try {
					closing.engine.close();
				} finally {
					await closing.release();
				}
				return undefined;
			}
		}
	};

	return (request) => {
		const result = queue.then(async (): Promise<SqlWorkerResponse> => {
			try {
				return { id: request.id, ok: true, value: await dispatch(request) };
			} catch (error) {
				return { id: request.id, ok: false, error: serializeError(error) };
			}
		});
		queue = result;
		return result;
	};
}

function serializeError(error: unknown): SqlWorkerError {
	if (error instanceof SqlStorageUnavailableError) {
		return { name: error.name, message: error.message, reason: error.reason };
	}
	if (error instanceof SqlImportRejectedError) {
		return {
			name: error.name,
			message: error.message,
			rejection: error.reason,
		};
	}
	return {
		name: error instanceof Error ? error.name : "Error",
		message: error instanceof Error ? error.message : String(error),
	};
}
