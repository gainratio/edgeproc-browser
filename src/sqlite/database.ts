import {
	applyMemoryProfile,
	type MemoryProfileSetting,
	resolveMemoryProfile,
} from "./memoryProfile.js";

export type SqliteStateValue = Uint8Array;

export type SqliteStatePersistence = "memory" | "opfs";

export interface SqliteStateStoreOptions {
	readonly name: string;
	/** Applied only when a new database is initialized. */
	readonly initialSchemaVersion: number;
	readonly persistence?: SqliteStatePersistence;
	/** SQLite page cache and heap limits. Default "auto": sized to the device, conservative on iOS. */
	readonly memoryProfile?: MemoryProfileSetting;
	readonly maxImportBytes?: number;
}

export interface SqliteStateRow {
	readonly namespace: string;
	readonly key: string;
	readonly value: Uint8Array;
	readonly revision: number;
}

export type SqliteStateMutation =
	| {
			readonly type: "put";
			readonly namespace: string;
			readonly key: string;
			readonly value: Uint8Array;
	  }
	| {
			readonly type: "delete";
			readonly namespace: string;
			readonly key: string;
	  };

export interface SqliteStateBatchOptions {
	readonly expectedEpoch?: number;
}

export interface SqliteStateBatchResult {
	readonly changed: number;
	readonly epoch: number;
}

export interface SqliteStateListOptions {
	readonly namespace: string;
	readonly prefix?: string;
	readonly afterKey?: string;
	readonly limit?: number;
}

export interface SqliteStateListPage {
	readonly rows: ReadonlyArray<SqliteStateRow>;
	readonly nextKey?: string;
}

export interface SqliteStateMigration {
	readonly fromVersion: number;
	readonly toVersion: number;
	readonly expectedEpoch?: number;
	readonly mutations: ReadonlyArray<SqliteStateMutation>;
}

export interface SqliteStateMigrationResult extends SqliteStateBatchResult {
	readonly schemaVersion: number;
}

export interface SqliteStateImportStage {
	readonly stageId: string;
	readonly schemaVersion: number;
	readonly epoch: number;
	readonly rowCount: number;
	readonly byteLength: number;
}

export interface SqliteStateImportResult extends SqliteStateBatchResult {
	readonly schemaVersion: number;
}

export interface SqliteStateIntegrityResult {
	readonly ok: true;
	readonly message: "ok";
}

export interface SqliteStateRuntimeInfo {
	readonly name: string;
	readonly sqliteVersion: string;
	readonly persistence: SqliteStatePersistence;
	readonly ownership: "isolated-worker" | "shared-opfs-web-locks";
	readonly schemaVersion: number;
	readonly epoch: number;
	readonly rowCount: number;
}

export type SqliteStateBindValue = string | number | null | Uint8Array;

/** Minimal private SQLite seam. It deliberately never crosses the public API. */
export interface SqliteStateDatabase {
	exec(sql: string, bind?: ReadonlyArray<SqliteStateBindValue>): void;
	selectObjects(
		sql: string,
		bind?: ReadonlyArray<SqliteStateBindValue>,
	): ReadonlyArray<Readonly<Record<string, unknown>>>;
	transaction<T>(callback: () => T): T;
	close(): void;
}

export interface SqliteStateDatabaseHandle {
	readonly pointer: number | bigint;
	exec(options: {
		readonly sql: string;
		readonly bind?: ReadonlyArray<unknown>;
	}): unknown;
	selectObjects(
		sql: string,
		bind?: ReadonlyArray<unknown>,
	): Array<Record<string, unknown>>;
	transaction<T>(callback: () => T): T;
	transaction<T>(qualifier: "IMMEDIATE", callback: () => T): T;
	close(): void;
}

export interface SqliteStateSnapshot {
	readonly schemaVersion: number;
	readonly epoch: number;
	readonly rows: ReadonlyArray<SqliteStateRow>;
}

export interface SqliteStateRuntime {
	readonly database: SqliteStateDatabase;
	exportBytes(): Uint8Array;
	readSnapshot(bytes: Uint8Array): SqliteStateSnapshot;
}

export class SqliteStateConflictError extends Error {
	public override readonly name = "SqliteStateConflictError";
}

export class SqliteStateSchemaError extends Error {
	public override readonly name = "SqliteStateSchemaError";
}

const META_TABLE = "edgeproc_state_meta";
const ROWS_TABLE = "edgeproc_state_rows";
const INTERNAL_SCHEMA_VERSION = 1;
const DEFAULT_MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_MAX_IMPORT_BYTES = 1024 * 1024 * 1024;
const MAX_NAMESPACE_LENGTH = 128;
const MAX_KEY_LENGTH = 4_096;
const MAX_BATCH_MUTATIONS = 10_000;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;

interface StagedImport {
	readonly stage: SqliteStateImportStage;
	readonly snapshot: SqliteStateSnapshot;
}

/**
 * Typed application-state operations over SQLite. SQL remains an implementation
 * detail so callers cannot accidentally couple themselves to the internal schema.
 */
export class SqliteStateStoreDatabase {
	public readonly name: string;
	readonly #database: SqliteStateDatabase;
	readonly #runtime: SqliteStateRuntime;
	readonly #persistence: SqliteStatePersistence;
	readonly #maxImportBytes: number;
	#disposed = false;
	#stageSequence = 0;
	#staged: StagedImport | undefined;

	public constructor(
		options: SqliteStateStoreOptions,
		database: SqliteStateDatabase,
		runtime: SqliteStateRuntime,
		persistent = true,
	) {
		validateName(options.name);
		validateVersion(options.initialSchemaVersion, "initial schema version");
		this.name = options.name;
		this.#database = database;
		this.#runtime = runtime;
		this.#persistence = persistent ? "opfs" : "memory";
		this.#maxImportBytes = validateImportLimit(
			options.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES,
		);
		if (options.memoryProfile !== undefined) {
			applyMemoryProfile(database, resolveMemoryProfile(options.memoryProfile));
		}
		this.#initialize(options.initialSchemaVersion);
	}

	public async get(
		namespace: string,
		key: string,
	): Promise<SqliteStateRow | undefined> {
		this.#assertOpen();
		validateNamespace(namespace);
		validateKey(key);
		const row = this.#database.selectObjects(
			`SELECT namespace, key, value, revision FROM ${ROWS_TABLE} WHERE namespace = ? AND key = ?`,
			[namespace, key],
		)[0];
		return row === undefined ? undefined : decodeRow(row);
	}

	public async list(
		options: SqliteStateListOptions,
	): Promise<SqliteStateListPage> {
		this.#assertOpen();
		validateNamespace(options.namespace);
		if (options.prefix !== undefined) validateKeyPart(options.prefix, "prefix");
		if (options.afterKey !== undefined) validateKey(options.afterKey);
		const limit = options.limit ?? DEFAULT_LIST_LIMIT;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
			throw new RangeError(
				`list limit must be an integer from 1 to ${MAX_LIST_LIMIT}`,
			);
		}
		const clauses = ["namespace = ?"];
		const bind: SqliteStateBindValue[] = [options.namespace];
		if (options.prefix !== undefined) {
			clauses.push("key >= ?", "key < ?");
			bind.push(options.prefix, prefixUpperBound(options.prefix));
		}
		if (options.afterKey !== undefined) {
			clauses.push("key > ?");
			bind.push(options.afterKey);
		}
		bind.push(limit + 1);
		const decoded = this.#database
			.selectObjects(
				`SELECT namespace, key, value, revision FROM ${ROWS_TABLE} WHERE ${clauses.join(" AND ")} ORDER BY key COLLATE BINARY ASC LIMIT ?`,
				bind,
			)
			.map(decodeRow);
		const hasMore = decoded.length > limit;
		const rows = decoded.slice(0, limit);
		const nextKey = hasMore ? rows.at(-1)?.key : undefined;
		return nextKey === undefined ? { rows } : { rows, nextKey };
	}

	public put(
		namespace: string,
		key: string,
		value: Uint8Array,
		options?: SqliteStateBatchOptions,
	): Promise<SqliteStateBatchResult> {
		return this.batch([{ type: "put", namespace, key, value }], options);
	}

	public delete(
		namespace: string,
		key: string,
		options?: SqliteStateBatchOptions,
	): Promise<SqliteStateBatchResult> {
		return this.batch([{ type: "delete", namespace, key }], options);
	}

	public async batch(
		mutations: ReadonlyArray<SqliteStateMutation>,
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateBatchResult> {
		this.#assertOpen();
		const accepted = validateAndCopyMutations(mutations);
		validateExpectedEpoch(options.expectedEpoch);
		return this.#database.transaction(() =>
			this.#applyBatch(accepted, options.expectedEpoch),
		);
	}

	public async migrate(
		migration: SqliteStateMigration,
	): Promise<SqliteStateMigrationResult> {
		this.#assertOpen();
		validateVersion(migration.fromVersion, "source schema version");
		validateVersion(migration.toVersion, "target schema version");
		if (migration.toVersion <= migration.fromVersion) {
			throw new RangeError("target schema version must be greater than source");
		}
		validateExpectedEpoch(migration.expectedEpoch);
		const accepted = validateAndCopyMutations(migration.mutations);
		return this.#database.transaction(() => {
			const currentVersion = this.#schemaVersion();
			if (currentVersion !== migration.fromVersion) {
				throw new SqliteStateSchemaError(
					`state schema is version ${currentVersion}; migration requires ${migration.fromVersion}`,
				);
			}
			const result = this.#applyBatch(accepted, migration.expectedEpoch, true);
			this.#setMeta("schema_version", migration.toVersion);
			return { ...result, schemaVersion: migration.toVersion };
		});
	}

	public async checkIntegrity(): Promise<SqliteStateIntegrityResult> {
		this.#assertOpen();
		const message = requireString(
			this.#database.selectObjects("PRAGMA integrity_check(1)")[0]
				?.integrity_check,
			"SQLite integrity result",
		);
		if (message !== "ok") {
			throw new Error(`SQLite integrity check failed: ${message}`);
		}
		return { ok: true, message: "ok" };
	}

	public async exportBytes(): Promise<Uint8Array> {
		this.#assertOpen();
		await this.checkIntegrity();
		if (this.#persistence === "opfs") {
			this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		}
		return this.#runtime.exportBytes().slice();
	}

	public async stageImport(bytes: Uint8Array): Promise<SqliteStateImportStage> {
		this.#assertOpen();
		if (!(bytes instanceof Uint8Array)) {
			throw new TypeError(
				"import must be a Uint8Array containing a SQLite database",
			);
		}
		if (bytes.byteLength === 0 || bytes.byteLength > this.#maxImportBytes) {
			throw new RangeError(
				`SQLite import must contain 1 to ${this.#maxImportBytes} bytes`,
			);
		}
		const snapshot = this.#runtime.readSnapshot(bytes.slice());
		validateVersion(snapshot.schemaVersion, "imported schema version");
		validateExpectedEpoch(snapshot.epoch);
		for (const row of snapshot.rows) {
			validateNamespace(row.namespace);
			validateKey(row.key);
			if (!(row.value instanceof Uint8Array)) {
				throw new TypeError(
					"imported state values must be Uint8Array instances",
				);
			}
			if (
				!Number.isSafeInteger(row.revision) ||
				row.revision < 0 ||
				row.revision > snapshot.epoch
			) {
				throw new Error(
					"imported state row revision is outside the imported epoch",
				);
			}
		}
		const stage: SqliteStateImportStage = {
			stageId: `stage-${++this.#stageSequence}`,
			schemaVersion: snapshot.schemaVersion,
			epoch: snapshot.epoch,
			rowCount: snapshot.rows.length,
			byteLength: bytes.byteLength,
		};
		this.#staged = { stage, snapshot: copySnapshot(snapshot) };
		return stage;
	}

	public async discardImport(stageId: string): Promise<void> {
		this.#assertOpen();
		if (this.#staged?.stage.stageId === stageId) this.#staged = undefined;
	}

	public async commitImport(
		stageId: string,
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateImportResult> {
		this.#assertOpen();
		validateExpectedEpoch(options.expectedEpoch);
		const staged = this.#staged;
		if (staged === undefined || staged.stage.stageId !== stageId) {
			throw new Error(
				"staged import does not exist or has already been consumed",
			);
		}
		const result = this.#database.transaction(() => {
			const currentEpoch = this.#epoch();
			this.#assertEpoch(currentEpoch, options.expectedEpoch);
			const oldCount = this.#rowCount();
			const nextEpoch = Math.max(currentEpoch, staged.snapshot.epoch) + 1;
			this.#database.exec(`DELETE FROM ${ROWS_TABLE}`);
			for (const row of staged.snapshot.rows) {
				this.#database.exec(
					`INSERT INTO ${ROWS_TABLE}(namespace, key, value, revision) VALUES(?, ?, ?, ?)`,
					[row.namespace, row.key, row.value, row.revision],
				);
			}
			this.#setMeta("schema_version", staged.snapshot.schemaVersion);
			this.#setMeta("epoch", nextEpoch);
			return {
				changed: oldCount + staged.snapshot.rows.length,
				epoch: nextEpoch,
				schemaVersion: staged.snapshot.schemaVersion,
			};
		});
		this.#staged = undefined;
		return result;
	}

	public async reset(
		options: SqliteStateBatchOptions = {},
	): Promise<SqliteStateBatchResult> {
		this.#assertOpen();
		validateExpectedEpoch(options.expectedEpoch);
		return this.#database.transaction(() => {
			const currentEpoch = this.#epoch();
			this.#assertEpoch(currentEpoch, options.expectedEpoch);
			const changed = this.#rowCount();
			if (changed === 0) return { changed, epoch: currentEpoch };
			this.#database.exec(`DELETE FROM ${ROWS_TABLE}`);
			const epoch = currentEpoch + 1;
			this.#setMeta("epoch", epoch);
			return { changed, epoch };
		});
	}

	public async runtimeInfo(): Promise<SqliteStateRuntimeInfo> {
		this.#assertOpen();
		return {
			name: this.name,
			sqliteVersion: requireString(
				this.#database.selectObjects("SELECT sqlite_version() AS version")[0]
					?.version,
				"SQLite version",
			),
			persistence: this.#persistence,
			ownership:
				this.#persistence === "opfs"
					? "shared-opfs-web-locks"
					: "isolated-worker",
			schemaVersion: this.#schemaVersion(),
			epoch: this.#epoch(),
			rowCount: this.#rowCount(),
		};
	}

	public async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#staged = undefined;
		this.#database.close();
	}

	#initialize(initialSchemaVersion: number): void {
		this.#database.exec("PRAGMA foreign_keys = ON");
		this.#database.exec("PRAGMA trusted_schema = OFF");
		const storedApplicationId = requireNonNegativeInteger(
			this.#database.selectObjects("PRAGMA application_id")[0]?.application_id,
			"SQLite application id",
		);
		const storedInternalVersion = requireNonNegativeInteger(
			this.#database.selectObjects("PRAGMA user_version")[0]?.user_version,
			"SQLite internal schema version",
		);
		if (storedApplicationId === 0 && storedInternalVersion === 0) {
			this.#database.exec(`PRAGMA application_id = ${applicationId()}`);
			this.#database.exec(`PRAGMA user_version = ${INTERNAL_SCHEMA_VERSION}`);
		} else if (
			storedApplicationId !== applicationId() ||
			storedInternalVersion !== INTERNAL_SCHEMA_VERSION
		) {
			throw new SqliteStateSchemaError(
				`unsupported SQLite state format (application ${storedApplicationId}, version ${storedInternalVersion})`,
			);
		}
		this.#database.exec(`
			CREATE TABLE IF NOT EXISTS ${META_TABLE}(
				key TEXT PRIMARY KEY NOT NULL,
				value INTEGER NOT NULL
			) WITHOUT ROWID;
			CREATE TABLE IF NOT EXISTS ${ROWS_TABLE}(
				namespace TEXT NOT NULL,
				key TEXT NOT NULL,
				value BLOB NOT NULL,
				revision INTEGER NOT NULL,
				PRIMARY KEY(namespace, key)
			) WITHOUT ROWID;
		`);
		this.#database.exec(
			`INSERT OR IGNORE INTO ${META_TABLE}(key, value) VALUES('schema_version', ?)`,
			[initialSchemaVersion],
		);
		this.#database.exec(
			`INSERT OR IGNORE INTO ${META_TABLE}(key, value) VALUES('epoch', 0)`,
		);
		this.#schemaVersion();
		this.#epoch();
	}

	#applyBatch(
		mutations: ReadonlyArray<SqliteStateMutation>,
		expectedEpoch: number | undefined,
		forceEpoch = false,
	): SqliteStateBatchResult {
		const currentEpoch = this.#epoch();
		this.#assertEpoch(currentEpoch, expectedEpoch);
		if (mutations.length === 0 && !forceEpoch) {
			return { changed: 0, epoch: currentEpoch };
		}
		const nextEpoch = currentEpoch + 1;
		let changed = 0;
		for (const mutation of mutations) {
			if (mutation.type === "put") {
				this.#database.exec(
					`INSERT INTO ${ROWS_TABLE}(namespace, key, value, revision) VALUES(?, ?, ?, ?)
					 ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, revision = excluded.revision`,
					[mutation.namespace, mutation.key, mutation.value, nextEpoch],
				);
			} else {
				this.#database.exec(
					`DELETE FROM ${ROWS_TABLE} WHERE namespace = ? AND key = ?`,
					[mutation.namespace, mutation.key],
				);
			}
			changed += this.#changedRows();
		}
		if (changed > 0 || forceEpoch) {
			this.#setMeta("epoch", nextEpoch);
			return { changed, epoch: nextEpoch };
		}
		return { changed, epoch: currentEpoch };
	}

	#assertEpoch(current: number, expected: number | undefined): void {
		if (expected !== undefined && current !== expected) {
			throw new SqliteStateConflictError(
				`state epoch is ${current}; expected ${expected}`,
			);
		}
	}

	#schemaVersion(): number {
		return this.#meta("schema_version", "state schema version");
	}

	#epoch(): number {
		return this.#meta("epoch", "state epoch");
	}

	#meta(key: string, label: string): number {
		return requireNonNegativeInteger(
			this.#database.selectObjects(
				`SELECT value FROM ${META_TABLE} WHERE key = ?`,
				[key],
			)[0]?.value,
			label,
		);
	}

	#setMeta(key: string, value: number): void {
		this.#database.exec(`UPDATE ${META_TABLE} SET value = ? WHERE key = ?`, [
			value,
			key,
		]);
	}

	#rowCount(): number {
		return requireNonNegativeInteger(
			this.#database.selectObjects(
				`SELECT COUNT(*) AS count FROM ${ROWS_TABLE}`,
			)[0]?.count,
			"state row count",
		);
	}

	#changedRows(): number {
		return requireNonNegativeInteger(
			this.#database.selectObjects("SELECT changes() AS changed")[0]?.changed,
			"SQLite changed row count",
		);
	}

	#assertOpen(): void {
		if (this.#disposed) {
			throw new Error(
				`SQLite state store ${JSON.stringify(this.name)} is disposed`,
			);
		}
	}
}

export function applicationId(): number {
	return 0x4550_5354; // ASCII "EPST"
}

export function internalSchemaVersion(): number {
	return INTERNAL_SCHEMA_VERSION;
}

function validateAndCopyMutations(
	mutations: ReadonlyArray<SqliteStateMutation>,
): ReadonlyArray<SqliteStateMutation> {
	if (!Array.isArray(mutations))
		throw new TypeError("mutations must be an array");
	if (mutations.length > MAX_BATCH_MUTATIONS) {
		throw new RangeError(
			`a batch may contain at most ${MAX_BATCH_MUTATIONS} mutations`,
		);
	}
	return mutations.map((mutation) => {
		validateNamespace(mutation.namespace);
		validateKey(mutation.key);
		if (mutation.type === "put") {
			if (!(mutation.value instanceof Uint8Array)) {
				throw new TypeError("state values must be Uint8Array instances");
			}
			return { ...mutation, value: mutation.value.slice() };
		}
		if (mutation.type !== "delete") {
			throw new TypeError("unsupported state mutation");
		}
		return { ...mutation };
	});
}

function decodeRow(row: Readonly<Record<string, unknown>>): SqliteStateRow {
	const value = row.value;
	if (!(value instanceof Uint8Array))
		throw new Error("state row value is not a BLOB");
	return {
		namespace: requireString(row.namespace, "state row namespace"),
		key: requireString(row.key, "state row key"),
		value: value.slice(),
		revision: requireNonNegativeInteger(row.revision, "state row revision"),
	};
}

function copySnapshot(snapshot: SqliteStateSnapshot): SqliteStateSnapshot {
	return {
		schemaVersion: snapshot.schemaVersion,
		epoch: snapshot.epoch,
		rows: snapshot.rows.map((row) => ({ ...row, value: row.value.slice() })),
	};
}

function prefixUpperBound(prefix: string): string {
	return `${prefix}\u{10ffff}`;
}

function validateName(name: string): void {
	if (typeof name !== "string" || name.length < 1 || name.length > 128) {
		throw new TypeError("state store name must contain 1 to 128 characters");
	}
}

function validateNamespace(namespace: string): void {
	validateBoundedString(namespace, "namespace", MAX_NAMESPACE_LENGTH, false);
}

function validateKey(key: string): void {
	validateBoundedString(key, "key", MAX_KEY_LENGTH, false);
}

function validateKeyPart(value: string, label: string): void {
	validateBoundedString(value, label, MAX_KEY_LENGTH, true);
}

function validateBoundedString(
	value: string,
	label: string,
	maxLength: number,
	allowEmpty: boolean,
): void {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		value.length > maxLength ||
		value.includes("\0")
	) {
		throw new TypeError(
			`${label} must contain ${allowEmpty ? "0" : "1"} to ${maxLength} non-NUL characters`,
		);
	}
}

function validateVersion(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${label} must be a positive safe integer`);
	}
}

function validateExpectedEpoch(value: number | undefined): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
		throw new RangeError("expected epoch must be a non-negative safe integer");
	}
}

function validateImportLimit(value: number): number {
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > MAX_MAX_IMPORT_BYTES
	) {
		throw new RangeError(
			`maxImportBytes must be an integer from 1 to ${MAX_MAX_IMPORT_BYTES}`,
		);
	}
	return value;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is not text`);
	return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${label} is not a non-negative safe integer`);
	}
	return value;
}
