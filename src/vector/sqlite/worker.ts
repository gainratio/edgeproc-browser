/// <reference lib="webworker" />

import { ownerLockWaitMs, type SqlLocks } from "../../sql/open.js";
import { SqlStorageUnavailableError } from "../../sql/types.js";
import { resolveMemoryProfile } from "../../sqlite/memoryProfile.js";
import sqlite3InitModule from "./assets/sqlite3.mjs";
import {
	type RawSqliteDatabase,
	type SqliteDatabase,
	SqliteDatabaseVectorIndex,
	wrapSqliteDatabase,
} from "./database.js";
import {
	createVectorWorkerHandler,
	type OpenedVectorIndex,
} from "./handler.js";
import { configureInlineOpfsProxy } from "./opfsAsyncProxy.js";
import { ownPool } from "./poolOwner.js";
import type {
	SqliteVectorWorkerOptions,
	SqliteVectorWorkerRequest,
} from "./protocol.js";

interface SahPool {
	readonly OpfsSAHPoolDb: new (filename: string) => RawSqliteDatabase;
	/** Close the pool's sync access handles (no data loss). */
	pauseVfs(): unknown;
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

const handle = createVectorWorkerHandler(openIndex);

self.onmessage = (event: MessageEvent<SqliteVectorWorkerRequest>) => {
	void handle(event.data).then((response) => self.postMessage(response));
};

async function openIndex(
	options: SqliteVectorWorkerOptions,
): Promise<OpenedVectorIndex> {
	let release: () => Promise<void> = async () => undefined;
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
		const opened = await openPersistent(
			sqlite,
			`edgeproc-vector-${identity}`,
			ownerLockWaitMs(
				resolveMemoryProfile(options.memoryProfile ?? "auto").tier,
			),
		);
		raw = opened.raw;
		release = opened.release;
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
			{ ...options, memoryProfile: options.memoryProfile ?? "auto" },
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
		return { index: opened, release };
	} catch (error) {
		try {
			database.close();
		} finally {
			await release();
		}
		throw error;
	}
}

/** Own the pool (see poolOwner.ts) and open the index's file in it. */
async function openPersistent(
	sqlite: SahPoolInstaller,
	poolName: string,
	waitMs: number,
): Promise<{
	readonly raw: RawSqliteDatabase;
	readonly release: () => Promise<void>;
}> {
	const owned = await ownPool(
		(navigator as { locks?: SqlLocks }).locks,
		poolName,
		waitMs,
		() => acquirePersistentPool(sqlite, poolName),
	);
	try {
		return {
			raw: new owned.pool.OpfsSAHPoolDb(`/${poolName}.sqlite3`),
			release: owned.release,
		};
	} catch (error) {
		await owned.release();
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
				throw new SqlStorageUnavailableError(
					"pool-in-use",
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

async function stableIdentity(name: string): Promise<string> {
	const bytes = new TextEncoder().encode(name);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return [...digest]
		.slice(0, 16)
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("");
}
