// Transaction state and transaction-control refusal, bound once from the
// sqlite-wasm module: sqlite3_get_autocommit says whether a transaction is
// still open, and an authorizer denies BEGIN/COMMIT/ROLLBACK/SAVEPOINT while
// an interactive transaction's own statements are prepared.

import type { SqlRawDatabase } from "./engine.js";

type Pointer = number | bigint;

/** The slice of the sqlite-wasm module this needs. */
export interface SqlControlModule {
	readonly capi: {
		readonly SQLITE_DENY: number;
		readonly SQLITE_OK: number;
		readonly SQLITE_SAVEPOINT: number;
		readonly SQLITE_TRANSACTION: number;
		sqlite3_get_autocommit(database: Pointer): number;
		sqlite3_set_authorizer(
			database: Pointer,
			authorizer: ((user: Pointer, action: number) => number) | 0,
			user: 0,
		): number;
	};
}

export interface SqlConnectionControl {
	/** Is a transaction open on `raw` (sqlite3_get_autocommit == 0)? */
	inTransaction(raw: SqlRawDatabase): boolean;
	/** Run `work` with every transaction-control statement denied. */
	withoutTransactionControl<T>(raw: SqlRawDatabase, work: () => T): T;
}

/** Narrow an initialised sqlite-wasm module to the slice this needs. */
export function isSqlControlModule(module: object): module is SqlControlModule {
	const capi = (module as { readonly capi?: Record<string, unknown> }).capi;
	return (
		typeof capi?.sqlite3_get_autocommit === "function" &&
		typeof capi.sqlite3_set_authorizer === "function" &&
		typeof capi.SQLITE_TRANSACTION === "number" &&
		typeof capi.SQLITE_SAVEPOINT === "number"
	);
}

export function createSqlConnectionControl(
	module: object,
): SqlConnectionControl {
	if (!isSqlControlModule(module)) {
		throw new TypeError("sqlite-wasm module lacks autocommit/authorizer APIs");
	}
	const { capi } = module;
	const deny = (_user: Pointer, action: number): number =>
		action === capi.SQLITE_TRANSACTION || action === capi.SQLITE_SAVEPOINT
			? capi.SQLITE_DENY
			: capi.SQLITE_OK;
	return {
		inTransaction: (raw) => capi.sqlite3_get_autocommit(pointerOf(raw)) === 0,
		withoutTransactionControl: (raw, work) => {
			capi.sqlite3_set_authorizer(pointerOf(raw), deny, 0);
			try {
				return work();
			} finally {
				capi.sqlite3_set_authorizer(pointerOf(raw), 0, 0);
			}
		},
	};
}

function pointerOf(raw: SqlRawDatabase): Pointer {
	if (raw.pointer === undefined) {
		throw new TypeError("SQLite handle has no native pointer");
	}
	return raw.pointer;
}
