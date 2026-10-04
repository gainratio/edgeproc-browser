// SQLite's own serialization, bound once from the sqlite-wasm module: export is
// sqlite3_serialize (via sqlite3_js_db_export), import is sqlite3_deserialize
// into an in-memory schema. No dump format: the bytes ARE a SQLite file.

import type { SqlRawDatabase } from "./engine.js";

/** The slice of the sqlite-wasm module serialization needs. */
export interface SqlSerializationModule {
	readonly oo1: { readonly DB: new (filename: string) => unknown };
	readonly capi: {
		readonly SQLITE_OK: number;
		sqlite3_deserialize(
			database: number | bigint,
			schema: string,
			bytes: number | bigint,
			size: bigint,
			bufferSize: bigint,
			flags: number,
		): number;
		sqlite3_js_db_export(
			database: number | bigint,
			schema?: string,
		): Uint8Array;
		sqlite3_errstr(code: number): string;
		sqlite3_complete(sql: string): number;
		sqlite3_drop_modules(
			database: number | bigint,
			keep: number | bigint,
		): number;
	};
	readonly wasm: {
		allocFromTypedArray(bytes: Uint8Array): number | bigint;
		dealloc(pointer: number | bigint): void;
		scopedAllocPush(): unknown;
		scopedAllocPop(scope: unknown): void;
		scopedAllocMainArgv(list: ReadonlyArray<string>): number | bigint;
	};
}

export interface SqlSerializer {
	/** The `main` schema of `raw` as a SQLite file. */
	serialize(raw: SqlRawDatabase): Uint8Array;
	/** sqlite3_complete: does `sql` end with a complete statement? */
	isComplete(sql: string): boolean;
	/** sqlite3_drop_modules: unregister every module not in `keep`. */
	keepOnlyModules(raw: SqlRawDatabase, keep: ReadonlyArray<string>): void;
	/** A fresh, empty in-memory connection. */
	scratch(): SqlRawDatabase;
	/**
	 * Load a copy of `bytes` into `schema` of `raw` (`main`, or an ATTACHed
	 * schema); fixed-size, and read-only when `readonly`. Returns the release
	 * for the copy: call it only after the schema is closed or DETACHed.
	 */
	deserialize(
		raw: SqlRawDatabase,
		schema: string,
		bytes: Uint8Array,
		readonly: boolean,
	): () => void;
}

const SQLITE_DESERIALIZE_READONLY = 4;

export function createSqlSerializer(
	sqlite: SqlSerializationModule,
): SqlSerializer {
	return {
		serialize: (raw) =>
			sqlite.capi.sqlite3_js_db_export(pointerOf(raw), "main"),
		isComplete: (sql) => sqlite.capi.sqlite3_complete(sql) !== 0,
		keepOnlyModules: (raw, keep) => {
			const scope = sqlite.wasm.scopedAllocPush();
			try {
				const code = sqlite.capi.sqlite3_drop_modules(
					pointerOf(raw),
					sqlite.wasm.scopedAllocMainArgv(keep),
				);
				if (code !== sqlite.capi.SQLITE_OK) {
					throw new Error(
						`sqlite3_drop_modules failed: ${sqlite.capi.sqlite3_errstr(code)}`,
					);
				}
			} finally {
				sqlite.wasm.scopedAllocPop(scope);
			}
		},
		scratch: () => new sqlite.oo1.DB(":memory:") as SqlRawDatabase,
		deserialize: (raw, schema, bytes, readonly) => {
			const copy = sqlite.wasm.allocFromTypedArray(bytes);
			const size = BigInt(bytes.byteLength);
			const code = sqlite.capi.sqlite3_deserialize(
				pointerOf(raw),
				schema,
				copy,
				size,
				size,
				readonly ? SQLITE_DESERIALIZE_READONLY : 0,
			);
			if (code !== sqlite.capi.SQLITE_OK) {
				sqlite.wasm.dealloc(copy);
				throw new Error(
					`sqlite3_deserialize failed: ${sqlite.capi.sqlite3_errstr(code)}`,
				);
			}
			return () => sqlite.wasm.dealloc(copy);
		},
	};
}

function pointerOf(raw: SqlRawDatabase): number | bigint {
	if (raw.pointer === undefined) {
		throw new TypeError("SQLite handle has no native pointer");
	}
	return raw.pointer;
}
