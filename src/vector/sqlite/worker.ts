/// <reference lib="webworker" />

import sqlite3InitModule from "./assets/sqlite3.mjs";
import {
	type RawSqliteDatabase,
	type SqliteDatabase,
	SqliteDatabaseVectorIndex,
	wrapSqliteDatabase,
} from "./database.js";
import { configureInlineOpfsProxy } from "./opfsAsyncProxy.js";
import type {
	SqliteVectorWorkerOptions,
	SqliteVectorWorkerRequest,
	SqliteVectorWorkerResponse,
} from "./protocol.js";

interface SahPool {
	readonly OpfsSAHPoolDb: new (filename: string) => RawSqliteDatabase;
}

interface SahPoolInstaller {
	installOpfsSAHPoolVfs(options: {
		name: string;
		forceReinitIfPreviouslyFailed?: boolean;
	}): Promise<SahPool>;
}

const POOL_ACQUIRE_MAX_ATTEMPTS = 8;
const POOL_ACQUIRE_INITIAL_DELAY_MS = 50;
const POOL_ACQUIRE_MAX_DELAY_MS = 800;

let index: SqliteDatabaseVectorIndex | undefined;
let queue = Promise.resolve();

self.onmessage = (event: MessageEvent<SqliteVectorWorkerRequest>) => {
	const request = event.data;
	queue = queue.then(() => handleRequest(request)).catch(() => undefined);
};

async function handleRequest(
	request: SqliteVectorWorkerRequest,
): Promise<void> {
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

async function dispatch(request: SqliteVectorWorkerRequest): Promise<unknown> {
	if (request.operation === "initialize") {
		if (index !== undefined) {
			throw new Error("SQLite vector worker is already initialized");
		}
		index = await openIndex(request.options);
		return index.capabilities;
	}
	const current = requireIndex();
	switch (request.operation) {
		case "insert":
			return current.insert(request.records);
		case "insert-keyed":
			return current.insertKeyed(request.records);
		case "read":
			return current.read(request.recordId);
		case "search":
			return current.search(request.query, request.limit, request.filters);
		case "search-by-ids":
			return current.searchByIds(request.query, request.ids);
		case "lookup-ids":
			return current.lookupIds(request.keys, request.maxDocumentFrequency);
		case "delete":
			return current.delete(request.ids, request.filters);
		case "delete-where":
			return current.deleteWhere(request.filters);
		case "clear":
			return current.clear();
		case "stats":
			return current.stats(request.filters);
		case "runtime-info":
			return current.runtimeInfo();
		case "dispose":
			await current.dispose();
			index = undefined;
			return undefined;
	}
}

async function openIndex(
	options: SqliteVectorWorkerOptions,
): Promise<SqliteDatabaseVectorIndex> {
	configureInlineOpfsProxy();
	const sqlite = await sqlite3InitModule({
		print: () => undefined,
		printErr: (...args) => console.error(...args),
	});
	const persistence = options.persistence ?? "opfs";
	let raw: RawSqliteDatabase;
	if (persistence === "memory") {
		raw = new sqlite.oo1.DB(":memory:");
	} else if (persistence === "opfs") {
		const identity = await stableIdentity(options.name);
		const pool = await acquirePersistentPool(
			sqlite,
			`edgeproc-vector-${identity}`,
		);
		raw = new pool.OpfsSAHPoolDb(`/edgeproc-vector-${identity}.sqlite3`);
	} else {
		throw new TypeError(
			`unsupported SQLite persistence: ${String(persistence)}`,
		);
	}

	const database = wrapSqliteDatabase(raw);
	try {
		if (persistence === "opfs") {
			configurePersistentDatabase(database);
		}
		const opened = new SqliteDatabaseVectorIndex(
			options,
			database,
			persistence === "opfs",
		);
		const runtime = opened.runtimeInfo();
		if (
			runtime.sqliteVersion !== "3.53.4" ||
			runtime.vectorVersion !== "1.1.2" ||
			runtime.bundledExtensions.join(",") !== "vector_version"
		) {
			throw new Error(
				`unexpected SQLite vector runtime: ${JSON.stringify(runtime)}`,
			);
		}
		return opened;
	} catch (error) {
		database.close();
		throw error;
	}
}

async function acquirePersistentPool(
	sqlite: SahPoolInstaller,
	name: string,
): Promise<SahPool> {
	let delayMs = POOL_ACQUIRE_INITIAL_DELAY_MS;
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await sqlite.installOpfsSAHPoolVfs({
				name,
				forceReinitIfPreviouslyFailed: true,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (!isPoolContentionError(error)) {
				throw new Error(`could not open the local vector database (${detail})`);
			}
			if (attempt >= POOL_ACQUIRE_MAX_ATTEMPTS) {
				throw new Error(
					`could not open the local vector database — this index may already be open in another tab (${detail})`,
				);
			}
			await sleep(delayMs);
			delayMs = Math.min(delayMs * 2, POOL_ACQUIRE_MAX_DELAY_MS);
		}
	}
}

function isPoolContentionError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === "NoModificationAllowedError" ||
			/access handles? cannot be created|NoModificationAllowedError/i.test(
				error.message,
			))
	);
}

function sleep(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function configurePersistentDatabase(database: SqliteDatabase): void {
	database.exec("PRAGMA secure_delete = ON");
	database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	const journal = database.selectObjects("PRAGMA journal_mode = DELETE")[0]
		?.journal_mode;
	const secureDelete = database.selectObjects("PRAGMA secure_delete")[0]
		?.secure_delete;
	if (journal !== "delete" || secureDelete !== 1) {
		throw new Error("persistent SQLite privacy pragmas were not applied");
	}
}

function requireIndex(): SqliteDatabaseVectorIndex {
	if (index === undefined) {
		throw new Error("SQLite vector worker is not initialized");
	}
	return index;
}

async function stableIdentity(name: string): Promise<string> {
	const bytes = new TextEncoder().encode(name);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest]
		.slice(0, 16)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}

function post(response: SqliteVectorWorkerResponse): void {
	self.postMessage(response);
}
