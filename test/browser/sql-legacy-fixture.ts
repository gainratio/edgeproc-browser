// Real-OPFS proof of migrateLegacySahPool: an old build crashes mid-write in
// its own opfs-sahpool, an old tab holds that pool, then the library moves the
// database into its own pool — recovered, row for row — and removes the old
// pool only because it was asked to.

import {
	type LegacySahPoolMigration,
	migrateLegacySahPool,
	openSqlDatabase,
	removeOpfsPool,
	removeSqlDatabase,
	SqlStorageUnavailableError,
} from "@gainratio/browser/sql";
import type { LegacyCommand } from "./legacy-pool-worker.js";

export interface LegacyProof {
	readonly refused?: string;
	readonly direct?: unknown;
	readonly whileHeld?: LegacySahPoolMigration;
	readonly migrated?: LegacySahPoolMigration;
	readonly attempts?: number;
	readonly rows?: number;
	readonly prefixes?: ReadonlyArray<string>;
	readonly identical?: boolean;
	readonly afterRemoval?: LegacySahPoolMigration;
}

declare global {
	interface Window {
		runLegacyProof(name: string, rows: number): Promise<LegacyProof>;
	}
}

function legacyWorker(): Worker {
	return new Worker(new URL("./legacy-pool-worker.ts", import.meta.url), {
		type: "module",
	});
}

function send(worker: Worker, command: LegacyCommand): Promise<unknown> {
	return new Promise((resolve, reject) => {
		worker.onmessage = (event: MessageEvent) => {
			const reply = event.data as {
				ok: boolean;
				value?: unknown;
				error?: string;
			};
			if (reply.ok) resolve(reply.value);
			else reject(new Error(reply.error));
		};
		worker.postMessage(command);
	});
}

/** One fresh Worker per step; terminate() is the crash (or the tab closing). */
async function step(command: LegacyCommand): Promise<unknown> {
	const worker = legacyWorker();
	try {
		return await send(worker, command);
	} finally {
		worker.terminate();
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The browser frees a terminated Worker's handles asynchronously; retry. */
async function untilFree<T extends { status: string }>(
	attempt: () => Promise<T>,
): Promise<{ value: T; attempts: number }> {
	for (let attempts = 1; ; attempts += 1) {
		const value = await attempt();
		if (value.status !== "in-use" || attempts >= 50) return { value, attempts };
		await sleep(100);
	}
}

window.runLegacyProof = async (name, rows): Promise<LegacyProof> => {
	const fromPool = `legacy-${name}`;
	const request = { fromPool, fromFile: "/kyc.sqlite3" };
	let target: Awaited<ReturnType<typeof openSqlDatabase>>;
	try {
		target = await openSqlDatabase({ name });
	} catch (error) {
		if (error instanceof SqlStorageUnavailableError) {
			return { refused: error.reason };
		}
		throw error;
	}

	// A build crashes mid-transaction: a torn file plus a hot journal.
	const tear = async (pool: string): Promise<void> => {
		const writer = legacyWorker();
		await send(writer, { op: "seed", pool, rows });
		await send(writer, { op: "tear" });
		writer.terminate();
	};

	// On a pool of its own (reading rolls the journal back and deletes it):
	// what reading through this build's sahpool VFS sees after the crash.
	const directPool = `${fromPool}-direct`;
	await tear(directPool);
	const direct = (
		await untilFree(async () => {
			try {
				return {
					status: "read",
					value: await step({ op: "direct", pool: directPool }),
				};
			} catch (error) {
				return { status: "in-use", value: String(error) };
			}
		})
	).value.value;
	await untilFree(async () => ({ status: await removeOpfsPool(directPool) }));

	await tear(fromPool);

	// An old tab that still has the pool open: in-use, nothing touched.
	const holder = legacyWorker();
	await untilFree(async () => {
		try {
			await send(holder, { op: "hold", pool: fromPool });
			return { status: "holding" };
		} catch {
			return { status: "in-use" };
		}
	});
	const whileHeld = await target.migrateLegacySahPool(request);
	holder.terminate();

	const { value: migrated, attempts } = await untilFree(() =>
		target.migrateLegacySahPool({ ...request, removeLegacy: true }),
	);
	const counted = await target.query<{ n: number; prefix: string }>(
		"SELECT count(*) AS n, substr(name, 1, 5) AS prefix FROM customers GROUP BY prefix",
	);
	const [same] = await target.query<{ ok: number }>(
		`SELECT count(*) = ? AS ok FROM customers
		 WHERE name = 'kept-' || id || '-' || printf('%.200c', 'x')`,
		[rows],
	);
	const afterRemoval = await migrateLegacySahPool({ ...request, to: target });
	await target.close();
	await removeSqlDatabase(name);
	return {
		direct,
		whileHeld,
		migrated,
		attempts,
		rows: counted.reduce((sum, row) => sum + row.n, 0),
		prefixes: counted.map((row) => row.prefix),
		identical: same?.ok === 1,
		afterRemoval,
	};
};
