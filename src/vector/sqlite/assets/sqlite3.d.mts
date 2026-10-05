type SqliteOo1Bind = ReadonlyArray<unknown> | Readonly<Record<string, unknown>>;

interface SqliteOo1Statement {
	bind(values: SqliteOo1Bind): SqliteOo1Statement;
	step(): boolean;
	get(target: Record<string, unknown>): Record<string, unknown>;
	reset(clearBindings?: boolean): SqliteOo1Statement;
	finalize(): number | undefined;
}

interface SqliteOo1Database {
	readonly pointer: number | bigint;
	exec(options: {
		readonly sql: string;
		readonly bind?: SqliteOo1Bind;
	}): unknown;
	selectObjects(
		sql: string,
		bind?: SqliteOo1Bind,
	): Array<Record<string, unknown>>;
	prepare(sql: string): SqliteOo1Statement;
	transaction<T>(callback: () => T): T;
	transaction<T>(qualifier: "IMMEDIATE", callback: () => T): T;
	close(): void;
}

interface SqliteSahPool {
	readonly OpfsSAHPoolDb: new (filename: string) => SqliteOo1Database;
	/** Close every sync access handle the pool holds (no data loss). */
	pauseVfs(): SqliteSahPool;
	/** True while paused (no handles held). */
	isPaused(): boolean;
	/** Re-acquire the handles of a paused pool. */
	unpauseVfs(): Promise<SqliteSahPool>;
	/** Files currently taking a slot. */
	getFileNames(): string[];
	/** Add slots until there are at least `min`; resolves to the capacity. */
	reserveMinimumCapacity(min: number): Promise<number>;
}

interface SqliteModule {
	readonly oo1: {
		readonly DB: new (filename: string) => SqliteOo1Database;
		readonly OpfsWlDb?: new (filename: string) => SqliteOo1Database;
	};
	installOpfsSAHPoolVfs(options: {
		name: string;
		forceReinitIfPreviouslyFailed?: boolean;
		/** Keep the pool's files when setup fails (local patch 0005). */
		preserveOnInitFailure?: boolean;
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
