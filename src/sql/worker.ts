/// <reference lib="webworker" />
// The SQL Worker entry: load the pinned SQLite build, open the named database
// (OPFS via opfs-sahpool, owner-locked; memory only as a reported fallback),
// apply the device memory profile, and answer the client's requests.

import { resolveMemoryProfile } from "../sqlite/memoryProfile.js";
import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import { configureInlineOpfsProxy } from "../vector/sqlite/opfsAsyncProxy.js";
import { SqlEngine, type SqlRawDatabase } from "./engine.js";
import { createSqlWorkerHandler, type OpenedSqlEngine } from "./handler.js";
import { openSqlStorage, type SqlLocks } from "./open.js";
import type { SqlWorkerRequest } from "./protocol.js";
import { createSqlSerializer } from "./serializer.js";
import type { SqlDatabaseOptions } from "./types.js";

const LOCK_WAIT_MS = 2_000;

const handle = createSqlWorkerHandler(openEngine);

self.onmessage = (event: MessageEvent<SqlWorkerRequest>) => {
	void handle(event.data).then((response) => self.postMessage(response));
};

async function openEngine(
	options: SqlDatabaseOptions,
): Promise<OpenedSqlEngine> {
	configureInlineOpfsProxy();
	const sqlite = await sqlite3InitModule({
		print: () => undefined,
		printErr: (...args) => console.error(...args),
	});
	const opened = await openSqlStorage<SqlRawDatabase>(
		{
			openMemory: () =>
				new sqlite.oo1.DB(":memory:") as unknown as SqlRawDatabase,
			installPool: async (name) =>
				(await sqlite.installOpfsSAHPoolVfs({
					name,
					forceReinitIfPreviouslyFailed: true,
				})) as unknown as {
					OpfsSAHPoolDb: new (file: string) => SqlRawDatabase;
				},
			locks: (navigator as { locks?: SqlLocks }).locks,
			warn: (message) => console.warn(message),
			lockWaitMs: LOCK_WAIT_MS,
		},
		options,
	);
	try {
		const engine = new SqlEngine(opened.raw, {
			storage: opened.storage,
			memoryProfile: resolveMemoryProfile(options.memoryProfile ?? "auto"),
			serializer: createSqlSerializer(sqlite),
		});
		return { engine, release: opened.release };
	} catch (error) {
		try {
			opened.raw.close();
		} finally {
			await opened.release();
		}
		throw error;
	}
}
