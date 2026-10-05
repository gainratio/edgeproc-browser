/// <reference lib="webworker" />

// Test-only Worker for the /vector/sqlite crash proof. It opens a vector
// index's own database file (same opfs-sahpool pool, same file, same pinned
// SQLite) and leaves a multi-row write transaction open after the pager has
// spilled pages into that file; the page then kills this Worker. The vector
// index's own Worker must roll the leftover journal back on its next open.
// (A real crash of the vector Worker mid-insert is timing-dependent: Chromium
// lets a busy Worker run on for ~2 s after terminate().)

import sqlite3InitModule from "../../src/vector/sqlite/assets/sqlite3.mjs";
import { configureInlineOpfsProxy } from "../../src/vector/sqlite/opfsAsyncProxy.js";

export interface WriterRequest {
	readonly pool: string;
}

interface Pool {
	OpfsSAHPoolDb: new (file: string) => { exec(sql: string): unknown };
}

const ATTEMPTS = 60;
const DELAY_MS = 50;

async function installPool(
	sqlite: { installOpfsSAHPoolVfs(o: object): Promise<unknown> },
	name: string,
): Promise<Pool> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return (await sqlite.installOpfsSAHPoolVfs({
				name,
				forceReinitIfPreviouslyFailed: true,
			})) as Pool;
		} catch (error) {
			// The previous owner's access handles are released asynchronously.
			if (attempt >= ATTEMPTS) throw error;
			await new Promise((r) => setTimeout(r, DELAY_MS));
		}
	}
}

self.onmessage = async ({ data }: MessageEvent<WriterRequest>) => {
	try {
		configureInlineOpfsProxy();
		const sqlite = await sqlite3InitModule();
		const pool = await installPool(sqlite, data.pool);
		const db = new pool.OpfsSAHPoolDb(`/${data.pool}.sqlite3`);
		db.exec(`PRAGMA cache_size = 10;
			BEGIN IMMEDIATE;
			UPDATE edgeproc_vector_metadata SET value_number = value_number + 1
			 WHERE key = 'generation';
			UPDATE edgeproc_vectors
			   SET metadata_json = json_set(metadata_json, '$.generation', 1);`);
		self.postMessage({ ok: true });
	} catch (error) {
		self.postMessage({ ok: false, error: String(error) });
	}
};
