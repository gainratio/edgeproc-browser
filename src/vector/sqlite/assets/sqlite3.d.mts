interface SqliteOo1Database {
	readonly pointer: number | bigint;
	exec(options: { sql: string; bind?: unknown[] }): unknown;
	selectObjects(sql: string, bind?: unknown[]): Array<Record<string, unknown>>;
	transaction<T>(callback: () => T): T;
	transaction<T>(qualifier: "IMMEDIATE", callback: () => T): T;
	close(): void;
}

interface SqliteSahPool {
	readonly OpfsSAHPoolDb: new (filename: string) => SqliteOo1Database;
}

interface SqliteModule {
	readonly oo1: {
		readonly DB: new (filename: string) => SqliteOo1Database;
		readonly OpfsWlDb?: new (filename: string) => SqliteOo1Database;
	};
	installOpfsSAHPoolVfs(options: {
		name: string;
		forceReinitIfPreviouslyFailed?: boolean;
	}): Promise<SqliteSahPool>;
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
			database: SqliteOo1Database | number | bigint,
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

export default function sqlite3InitModule(options?: {
	locateFile?: (filename: string) => string;
	print?: (...args: unknown[]) => void;
	printErr?: (...args: unknown[]) => void;
	wasmBinary?: Uint8Array;
}): Promise<SqliteModule>;
