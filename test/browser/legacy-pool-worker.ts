/// <reference lib="webworker" />

// Plays the OLD build: a plain sqlite3.mjs opfs-sahpool, the way an app wired
// @sqlite.org/sqlite-wasm itself. "seed" commits rows; "tear" starts a big
// UPDATE with a tiny page cache so modified pages spill into the database
// file, then answers WITHOUT committing — the page terminates this Worker,
// which is a crash mid-transaction: a torn file plus a hot rollback journal.
// "hold" keeps the pool's access handles, like an old tab left open.
// "direct" reads through the sahpool VFS itself, to show what it would see.

import sqlite3InitModule from "../../src/vector/sqlite/assets/sqlite3.mjs";

export type LegacyCommand =
	| { readonly op: "seed"; readonly pool: string; readonly rows: number }
	| { readonly op: "tear" }
	| { readonly op: "hold"; readonly pool: string }
	| { readonly op: "direct"; readonly pool: string };

export const LEGACY_FILE = "/kyc.sqlite3";

interface Db {
	exec(sql: string): unknown;
	selectValue(sql: string): unknown;
	close(): void;
}

interface Pool {
	readonly OpfsSAHPoolDb: new (file: string) => Db;
	getFileNames(): string[];
	pauseVfs(): unknown;
}

let db: Db | undefined;

async function pool(name: string): Promise<Pool> {
	const sqlite = await sqlite3InitModule({ print: () => undefined });
	return (await sqlite.installOpfsSAHPoolVfs({
		name,
		forceReinitIfPreviouslyFailed: true,
	})) as unknown as Pool;
}

async function run(command: LegacyCommand): Promise<unknown> {
	switch (command.op) {
		case "seed": {
			const p = await pool(command.pool);
			db = new p.OpfsSAHPoolDb(LEGACY_FILE);
			db.exec(`PRAGMA journal_mode = DELETE;
				CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
				WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${command.rows})
				INSERT INTO customers SELECT i, 'kept-' || i || '-' || printf('%.200c', 'x') FROM n;`);
			return "seeded";
		}
		case "tear":
			db?.exec(`PRAGMA cache_size = 1; PRAGMA cache_spill = 1;
				BEGIN; UPDATE customers SET name = replace(name, 'kept-', 'torn-');`);
			return "torn";
		case "hold":
			await pool(command.pool);
			return "holding";
		case "direct": {
			const p = await pool(command.pool);
			const files = p.getFileNames();
			const reader = new p.OpfsSAHPoolDb(LEGACY_FILE);
			try {
				const first = reader.selectValue(
					"SELECT substr(name, 1, 5) FROM customers WHERE id = 1",
				);
				return { files, first };
			} catch (error) {
				return { files, first: `error: ${String(error)}` };
			} finally {
				reader.close();
				p.pauseVfs();
			}
		}
	}
}

self.onmessage = (event: MessageEvent<LegacyCommand>) => {
	run(event.data).then(
		(value) => self.postMessage({ ok: true, value }),
		(error: unknown) => self.postMessage({ ok: false, error: String(error) }),
	);
};
