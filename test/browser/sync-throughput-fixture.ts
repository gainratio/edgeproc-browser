// Page side of the cold-sync throughput harness: one fresh Worker per run,
// plus the SQLite insert phase a consumer runs over the synced rows.

import { openSqlDatabase, removeSqlDatabase } from "@gainratio/browser/sql";
import type {
	PhaseTimings,
	TamperResult,
	ThroughputRequest,
} from "./sync-throughput-worker.js";

export interface SqlInsertTimings {
	readonly storage: string;
	readonly rows: number;
	readonly oneTransactionMs: number;
	readonly perRowMs: number;
}

interface ThroughputHarness {
	sqlInsert(rows: number, rowBytes: number): Promise<SqlInsertTimings>;
	cold(
		baseUrl: string,
		keyUrl: string,
		backend: "auto" | "indexeddb",
	): Promise<PhaseTimings>;
	tamper(
		baseUrl: string,
		keyUrl: string,
		tamperHash: string,
		substituteHash: string,
	): Promise<TamperResult>;
}

declare global {
	interface Window {
		throughput: ThroughputHarness;
	}
}

function run<T>(request: ThroughputRequest): Promise<T> {
	const worker = new Worker(
		new URL("./sync-throughput-worker.ts", import.meta.url),
		{ type: "module" },
	);
	return new Promise<T>((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => {
			worker.terminate();
			const data = event.data as { ok: boolean; result?: T; error?: string };
			if (data.ok) resolve(data.result as T);
			else reject(new Error(data.error));
		};
		worker.onerror = (event) => {
			worker.terminate();
			reject(new Error(event.message));
		};
		worker.postMessage(request);
	});
}

const SQL_NAME = "throughput-insert";

/** One row per chunk into an OPFS SQLite table: once in a single
 * transaction (what the SQL seam's `transaction` does), once autocommit. */
async function sqlInsert(
	count: number,
	rowBytes: number,
): Promise<SqlInsertTimings> {
	await removeSqlDatabase(SQL_NAME).catch(() => undefined);
	const sql = await openSqlDatabase({
		name: SQL_NAME,
		persistence: "opfs",
		fallback: "memory",
	});
	try {
		await sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, body BLOB)");
		const rows = Array.from({ length: count }, (_, id) => [
			id,
			new Uint8Array(rowBytes).fill(id % 251),
		]);
		let started = performance.now();
		await sql.transaction([{ sql: "INSERT INTO t VALUES (?, ?)", rows }]);
		const oneTransactionMs = performance.now() - started;
		await sql.exec("DELETE FROM t");
		started = performance.now();
		for (const row of rows) await sql.exec("INSERT INTO t VALUES (?, ?)", row);
		return {
			storage: sql.storage.persistence,
			rows: count,
			oneTransactionMs,
			perRowMs: performance.now() - started,
		};
	} finally {
		await sql.close();
	}
}

window.throughput = {
	sqlInsert,
	cold: (baseUrl, keyUrl, backend) =>
		run({ kind: "cold", baseUrl, keyUrl, backend }),
	tamper: (baseUrl, keyUrl, tamperHash, substituteHash) =>
		run({ kind: "tamper", baseUrl, keyUrl, tamperHash, substituteHash }),
};
