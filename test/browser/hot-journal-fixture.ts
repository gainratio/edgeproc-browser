// Crash-recovery proof for the opfs-sahpool data paths (/sql and
// /vector/sqlite). Each round starts a multi-row write transaction in the
// library's own Worker, terminates that Worker mid-transaction (the closest a
// page gets to a tab crash or a killed process), reopens the database through
// the public API and reads the APPLICATION invariant back. A rolled-back
// transaction leaves every row on the old generation; a torn one mixes
// generations, breaks a+b=100, or loses rows, while PRAGMA integrity_check can
// still say "ok". SQLite 3.53.4's sahpool xCheckReservedLock always reported a
// RESERVED lock, so the pager never rolled the leftover journal back.
import {
	openSqlDatabase,
	removeOpfsPool,
	removeSqlDatabase,
	type SqlDatabase,
	SqlStorageUnavailableError,
	sqliteVectorPoolName,
} from "@gainratio/browser/sql";
import { SqliteVectorIndexClient } from "@gainratio/browser/vector/sqlite";
import type { WriterRequest } from "./hot-journal-writer.js";

const SQL_ROWS = 300;
const VECTOR_RECORDS = 2000;
const DIMENSION = 128;
const REOPEN_ATTEMPTS = 60;
const REOPEN_DELAY_MS = 50;

/** rolled-back: every row still on the old generation, the only correct
 * outcome (the kill always lands inside the open transaction). torn: any
 * other state, including a database SQLite now reports as corrupt. */
export type Outcome = "rolled-back" | "torn";

export interface RoundResult {
	readonly outcome: Outcome;
	readonly integrity: string;
	readonly detail: string;
}

export interface HotJournalProof {
	readonly storage: string;
	readonly rounds: ReadonlyArray<RoundResult>;
}

declare global {
	interface Window {
		runSqlHotJournalProof(
			name: string,
			rounds: number,
		): Promise<HotJournalProof>;
		runVectorHotJournalProof(
			name: string,
			rounds: number,
		): Promise<HotJournalProof>;
		opfsAvailable(): Promise<boolean>;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A Worker factory that remembers the Worker so the test can kill it. */
function killable(url: string, name: string) {
	let worker: Worker | undefined;
	const factory = () => {
		worker = new Worker(new URL(url, location.href), { type: "module", name });
		return worker;
	};
	return { factory, kill: () => worker?.terminate() };
}

/** The killed Worker's access handles are released asynchronously. */
async function reopen<T>(open: () => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await open();
		} catch (error) {
			const contended =
				error instanceof SqlStorageUnavailableError &&
				error.reason === "pool-in-use";
			if (!contended || attempt >= REOPEN_ATTEMPTS) throw error;
			await sleep(REOPEN_DELAY_MS);
		}
	}
}

async function sqlCheck(db: SqlDatabase, generation: number) {
	const [row] = await db.query(
		"SELECT count(*) AS n, min(a) AS lo, max(a) AS hi, sum(a + b <> 100) AS bad FROM t",
	);
	const [check] = await db.query("PRAGMA integrity_check");
	const rolledBack =
		row?.n === SQL_ROWS &&
		row.lo === generation &&
		row.hi === generation &&
		row.bad === 0;
	return {
		outcome: rolledBack ? ("rolled-back" as const) : ("torn" as const),
		integrity: String(check?.integrity_check),
		detail: JSON.stringify(row),
	};
}

window.runSqlHotJournalProof = async (name, rounds) => {
	const db = await openSqlDatabase({ name });
	const storage = db.storage.persistence;
	await db.exec(
		`CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b INT, pad BLOB);
		 WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${SQL_ROWS})
		 INSERT INTO t SELECT i, 0, 100, zeroblob(3000) FROM c;`,
	);
	await db.close();
	const results: RoundResult[] = [];
	for (let round = 0; round < rounds; round += 1) {
		const worker = killable("/dist/sql/worker.js", "edgeproc-sql-crash");
		const victim = await reopen(() =>
			openSqlDatabase({ name }, { workerFactory: worker.factory }),
		);
		// A tiny page cache makes the pager spill dirty pages into the database
		// file while the transaction is still open — the state a crash can hit.
		await victim.exec(
			"PRAGMA cache_size = 10; BEGIN IMMEDIATE; UPDATE t SET a = a + 1, b = b - 1, pad = randomblob(3000);",
		);
		worker.kill();
		const survivor = await reopen(() => openSqlDatabase({ name }));
		results.push(await sqlCheck(survivor, 0));
		await survivor.close();
	}
	await removeSqlDatabase(name);
	return { storage, rounds: results };
};

function records(generation: number) {
	return Array.from({ length: VECTOR_RECORDS }, (_, i) => {
		const vector = new Float32Array(DIMENSION);
		vector[i % DIMENSION] = 1;
		return { id: `r${i}`, vector, metadata: { generation } };
	});
}

function vectorIndex(name: string): Promise<SqliteVectorIndexClient> {
	return reopen(async () => {
		const index = new SqliteVectorIndexClient({ name, dimension: DIMENSION });
		await index.ready();
		return index;
	});
}

async function vectorCheck(
	index: SqliteVectorIndexClient,
): Promise<RoundResult> {
	const all = (await index.stats()).vectorCount;
	const old = (await index.stats({ generation: 0 })).vectorCount;
	return {
		outcome: all === VECTOR_RECORDS && old === all ? "rolled-back" : "torn",
		integrity: "n/a",
		detail: JSON.stringify({ all, old }),
	};
}

/** Leave a spilled write transaction open in the index's file, then kill. */
async function tearVectorFile(pool: string): Promise<void> {
	const writer = new Worker(
		new URL("./hot-journal-writer.ts", import.meta.url),
		{
			type: "module",
			name: "edgeproc-hot-journal-writer",
		},
	);
	try {
		const reply = await new Promise<{ ok: boolean; error?: string }>(
			(resolve) => {
				writer.onmessage = ({ data }) => resolve(data);
				writer.postMessage({ pool } satisfies WriterRequest);
			},
		);
		if (!reply.ok) throw new Error(`writer failed: ${reply.error}`);
	} finally {
		writer.terminate();
	}
}

window.runVectorHotJournalProof = async (name, rounds) => {
	const seed = await vectorIndex(name);
	await seed.insert(records(0));
	await seed.dispose();
	const pool = await sqliteVectorPoolName(name);
	const results: RoundResult[] = [];
	for (let round = 0; round < rounds; round += 1) {
		await tearVectorFile(pool);
		// The library's own vector Worker reopens the file and must roll the
		// hot journal back: every record still on generation 0.
		const result = await vectorIndex(name).then(
			async (survivor) => {
				try {
					return await vectorCheck(survivor);
				} finally {
					await survivor.dispose();
				}
			},
			(error: unknown) => ({
				outcome: "torn" as const,
				integrity: "n/a",
				detail: String(error),
			}),
		);
		results.push(result);
	}
	await removeOpfsPool(pool);
	return { storage: "opfs", rounds: results };
};

window.opfsAvailable = () =>
	navigator.storage.getDirectory().then(
		() => true,
		() => false,
	);
