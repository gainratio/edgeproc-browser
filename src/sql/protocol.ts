import type {
	MigrateLegacySahPoolOptions,
	SqlBind,
	SqlDatabaseOptions,
	SqlFallbackReason,
	SqlImportOptions,
	SqlImportRejection,
	SqlStatement,
} from "./types.js";

type WithId<T> = T & { readonly id: number };

export type SqlWorkerRequest = WithId<
	| {
			readonly operation: "open";
			readonly options: SqlDatabaseOptions;
			/** A bounded by-name operation, not a connection. */
			readonly transient?: true;
	  }
	| {
			readonly operation: "exec";
			readonly sql: string;
			readonly bind?: SqlBind;
	  }
	| {
			readonly operation: "query" | "tx-exec" | "tx-query";
			readonly sql: string;
			readonly bind?: SqlBind;
	  }
	| {
			readonly operation: "transaction";
			readonly statements: ReadonlyArray<SqlStatement>;
	  }
	| {
			readonly operation: "execute-many";
			readonly sql: string;
			readonly rows: ReadonlyArray<SqlBind>;
	  }
	| { readonly operation: "begin" | "commit" | "rollback" }
	| { readonly operation: "prepare"; readonly sql: string }
	| {
			readonly operation: "run-prepared" | "all-prepared";
			readonly statement: number;
			readonly bind?: SqlBind;
	  }
	| { readonly operation: "finalize"; readonly statement: number }
	| { readonly operation: "export" }
	| {
			readonly operation: "import";
			readonly bytes: Uint8Array;
			readonly options?: SqlImportOptions;
	  }
	| {
			readonly operation: "migrate-legacy";
			readonly options: MigrateLegacySahPoolOptions;
	  }
	| { readonly operation: "runtime-info" }
	| { readonly operation: "close" }
>;

export interface SqlWorkerError {
	readonly name: string;
	readonly message: string;
	readonly reason?: SqlFallbackReason;
	readonly rejection?: SqlImportRejection;
}

export type SqlWorkerResponse =
	| { readonly id: number; readonly ok: true; readonly value: unknown }
	| { readonly id: number; readonly ok: false; readonly error: SqlWorkerError };
