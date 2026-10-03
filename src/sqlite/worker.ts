/// <reference lib="webworker" />

import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { configureInlineOpfsProxy } from "../vector/sqlite/opfsAsyncProxy.js";
import {
	type SqliteStateDatabase,
	type SqliteStateDatabaseHandle,
	SqliteStateStoreDatabase,
} from "./database.js";
import type {
	SqliteStateWorkerRequest,
	SqliteStateWorkerResponse,
} from "./protocol.js";
import { createSqliteStateRuntime, type SqliteStateModule } from "./runtime.js";

let store: SqliteStateStoreDatabase | undefined;
let databaseLockName: string | undefined;
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<SqliteStateWorkerRequest>) => {
	const request = event.data;
	queue = queue.then(() => handleRequest(request)).catch(() => undefined);
};

async function handleRequest(request: SqliteStateWorkerRequest): Promise<void> {
	try {
		const value = await dispatch(request);
		post({ id: request.id, ok: true, value });
	} catch (error) {
		post({
			id: request.id,
			ok: false,
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
		});
	}
}

async function dispatch(request: SqliteStateWorkerRequest): Promise<unknown> {
	if (request.operation === "initialize") {
		if (store !== undefined)
			throw new Error("SQLite state worker is already initialized");
		const lockName = await databaseLockNameFor(request.options);
		const opened = await withDatabaseLock(lockName, async () => {
			const created = await openStore(request.options);
			return { created, info: await created.runtimeInfo() };
		});
		store = opened.created;
		databaseLockName = lockName;
		return opened.info;
	}
	const current = requireStore();
	if (request.operation === "dispose") {
		await withDatabaseLock(databaseLockName, () => current.dispose());
		store = undefined;
		databaseLockName = undefined;
		return undefined;
	}
	return withDatabaseLock(databaseLockName, () => run(current, request));
}

function run(
	current: SqliteStateStoreDatabase,
	request: Exclude<
		SqliteStateWorkerRequest,
		{ readonly operation: "initialize" | "dispose" }
	>,
): Promise<unknown> | unknown {
	switch (request.operation) {
		case "get":
			return current.get(request.namespace, request.key);
		case "list":
			return current.list(request.options);
		case "batch":
			return current.batch(request.mutations, request.options);
		case "migrate":
			return current.migrate(request.migration);
		case "integrity-check":
			return current.checkIntegrity();
		case "export":
			return current.exportBytes();
		case "stage-import":
			return current.stageImport(request.bytes);
		case "discard-import":
			return current.discardImport(request.stageId);
		case "commit-import":
			return current.commitImport(request.stageId, request.options);
		case "reset":
			return current.reset(request.options);
		case "runtime-info":
			return current.runtimeInfo();
	}
}

/**
 * The per-database Web Lock every OPFS operation runs under, or undefined for
 * an in-memory store (nothing shared, nothing to serialize).
 *
 * Why every operation, reads included: SQLite's opfs-wl VFS maps its SHARED
 * lock to a *shared* Web Lock, so two tabs may both hold it. But each SQLite
 * lock also needs the file's OPFS sync access handle, and Chromium grants only
 * one per file. The second tab's createSyncAccessHandle() then fails with
 * NoModificationAllowedError, retries five times, logs
 * `GetSyncHandleError` to the console, and returns SQLITE_BUSY — the store
 * fails to open, or a read fails. Taking this exclusive lock around the whole
 * operation means only one context at a time ever asks for the handle, so the
 * other tab queues (FIFO, managed by the browser) instead of failing.
 *
 * The name predates this change, when only mutations took it; keeping it means
 * a tab still running an older build excludes this one for writes.
 */
async function databaseLockNameFor(
	options: ConstructorParameters<typeof SqliteStateStoreDatabase>[0],
): Promise<string | undefined> {
	if ((options.persistence ?? "opfs") !== "opfs") return undefined;
	return `edgeproc-state-transaction-${await stableIdentity(options.name)}`;
}

async function openStore(
	options: ConstructorParameters<typeof SqliteStateStoreDatabase>[0],
): Promise<SqliteStateStoreDatabase> {
	configureInlineOpfsProxy();
	const loaded = await sqlite3InitModule({
		print: () => undefined,
		printErr: (...args) => console.error(...args),
	});
	const sqlite = loaded as unknown as SqliteStateModule;
	const persistence = options.persistence ?? "opfs";
	let raw: SqliteStateDatabaseHandle;
	if (persistence === "memory") {
		raw = new sqlite.oo1.DB(":memory:");
	} else if (persistence === "opfs") {
		const identity = await stableIdentity(options.name);
		const OpfsWlDb = sqlite.oo1.OpfsWlDb;
		if (OpfsWlDb === undefined) {
			throw new Error(
				"could not open the local state database — SQLite OPFS Web Locks support is unavailable",
			);
		}
		raw = new OpfsWlDb(`/edgeproc-state-${identity}.sqlite3`);
	} else {
		throw new TypeError(
			`unsupported SQLite persistence: ${String(persistence)}`,
		);
	}

	const runtime = createSqliteStateRuntime(sqlite, raw);
	try {
		if (persistence === "opfs") configurePersistentDatabase(runtime.database);
		const opened = new SqliteStateStoreDatabase(
			options,
			runtime.database,
			runtime,
			persistence === "opfs",
		);
		const info = await opened.runtimeInfo();
		if (info.sqliteVersion !== "3.53.4") {
			throw new Error(`unexpected SQLite runtime: ${info.sqliteVersion}`);
		}
		return opened;
	} catch (error) {
		runtime.database.close();
		throw error;
	}
}

function configurePersistentDatabase(database: SqliteStateDatabase): void {
	database.exec("PRAGMA secure_delete = ON");
	database.exec("PRAGMA busy_timeout = 5000");
	database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	const journal = database.selectObjects("PRAGMA journal_mode = DELETE")[0]
		?.journal_mode;
	const secureDelete = database.selectObjects("PRAGMA secure_delete")[0]
		?.secure_delete;
	const busyTimeout = database.selectObjects("PRAGMA busy_timeout")[0]?.timeout;
	if (journal !== "delete" || secureDelete !== 1 || busyTimeout !== 5_000) {
		throw new Error("persistent SQLite privacy pragmas were not applied");
	}
}

function requireStore(): SqliteStateStoreDatabase {
	if (store === undefined)
		throw new Error("SQLite state worker is not initialized");
	return store;
}

async function withDatabaseLock<T>(
	lockName: string | undefined,
	action: () => Promise<T> | T,
): Promise<T> {
	if (lockName === undefined) return action();
	if (navigator.locks === undefined) {
		throw new Error(
			"could not use the local state database — browser Web Locks support is unavailable",
		);
	}
	return navigator.locks.request(lockName, { mode: "exclusive" }, action);
}

async function stableIdentity(name: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)),
	);
	return [...digest]
		.slice(0, 16)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

function post(response: SqliteStateWorkerResponse): void {
	if (response.ok && response.value instanceof Uint8Array) {
		self.postMessage(response, { transfer: [response.value.buffer] });
		return;
	}
	self.postMessage(response);
}
