/// <reference lib="webworker" />
// The SQL Worker entry: load the pinned SQLite build, open the named database
// (OPFS via opfs-sahpool, owner-locked; memory only as a reported fallback),
// apply the device memory profile, and answer the client's requests.

import { resolveMemoryProfile } from "../sqlite/memoryProfile.js";
import { createSqlConnectionControl } from "./control.js";
import { SqlEngine, type SqlRawDatabase } from "./engine.js";
import { createSqlWorkerHandler, type OpenedSqlEngine } from "./handler.js";
import {
	asLegacySahPool,
	createJournalRecovery,
	migrateLegacySahPool,
	opfsPoolExists,
} from "./legacy.js";
import { openSqlStorage, ownerLockWaitMs, type SqlLocks } from "./open.js";
import type { SqlWorkerRequest } from "./protocol.js";
import { sahPoolInstallOptions } from "./sahPool.js";
import { createSqlSerializer } from "./serializer.js";
import type { SqlDatabaseOptions, SqlStorage } from "./types.js";
import {
	type LoadedSqlite,
	loadSqlite,
	workerStorageDeps,
} from "./workerRuntime.js";

const handle = createSqlWorkerHandler(openEngine);

self.onmessage = (event: MessageEvent<SqlWorkerRequest>) => {
	void handle(event.data).then((response) => self.postMessage(response));
};

async function openEngine(
	options: SqlDatabaseOptions,
	context: { readonly transient: boolean },
): Promise<OpenedSqlEngine> {
	const sqlite = await loadSqlite();
	const profile = resolveMemoryProfile(options.memoryProfile ?? "auto");
	const lockWaitMs = ownerLockWaitMs(profile.tier);
	const opened = await openSqlStorage<SqlRawDatabase>(
		workerStorageDeps(sqlite, lockWaitMs, profile.tempStore),
		options,
		context,
	);
	try {
		const engine = new SqlEngine(opened.raw, {
			storage: opened.storage,
			memoryProfile: profile,
			serializer: createSqlSerializer(sqlite),
			control: createSqlConnectionControl(sqlite),
		});
		return {
			engine,
			release: opened.release,
			migrateLegacy: legacyMigrator(sqlite, opened.storage, engine, lockWaitMs),
		};
	} catch (error) {
		try {
			opened.raw.close();
		} finally {
			await opened.release();
		}
		throw error;
	}
}

function navigatorLocks(): SqlLocks | undefined {
	return (navigator as { locks?: SqlLocks }).locks;
}

/** Legacy opfs-sahpool migration on this Worker's module and connection. */
function legacyMigrator(
	sqlite: LoadedSqlite,
	storage: SqlStorage,
	engine: SqlEngine,
	lockWaitMs: number,
): NonNullable<OpenedSqlEngine["migrateLegacy"]> {
	const recover = createJournalRecovery(sqlite);
	return (request) =>
		migrateLegacySahPool(
			{
				locks: navigatorLocks(),
				lockWaitMs,
				ownPool: storage.persistence === "opfs" ? storage.pool : undefined,
				poolExists: async (pool) =>
					opfsPoolExists(pool, await navigator.storage.getDirectory()),
				installPool: async (name) =>
					asLegacySahPool(
						await sqlite.installOpfsSAHPoolVfs(sahPoolInstallOptions(name)),
					),
				recover,
				importDatabase: (bytes, options) =>
					engine.importDatabase(bytes, options),
			},
			request,
		);
}
