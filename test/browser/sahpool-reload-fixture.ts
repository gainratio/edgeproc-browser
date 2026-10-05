// Reload proof for the opfs-sahpool slot guards (src/sql/sahPool.ts). Each
// round opens the database in a Worker, writes, starts close() and kills the
// Worker while that close is in flight (a reload tearing the old page down),
// then reopens at once through the public API with NO retry of its own: the
// library must absorb the old Worker's still-closing handles, keep every
// slot, and still have room for the journal of the next write. Before 0.3.2
// a lost race deleted the free slots and the journal eventually failed with
// "SAH pool is full".
import {
	openSqlDatabase,
	removeSqlDatabase,
	sqlDatabasePoolName,
} from "@gainratio/browser/sql";
import type { GhostRequest } from "./sahpool-ghost-worker.js";

export interface ReloadRound {
	readonly slots: number;
	readonly error: string | null;
}

export interface ReloadProof {
	readonly storage: string;
	readonly initialSlots: number;
	readonly rounds: ReadonlyArray<ReloadRound>;
	readonly rows: unknown;
}

declare global {
	interface Window {
		runSahPoolReloadProof(name: string, rounds: number): Promise<ReloadProof>;
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

/** The pool's slot files on disk (listing works while handles are held). */
async function slotCount(pool: string): Promise<number> {
	const root = await navigator.storage.getDirectory();
	const opaque = await (
		await root.getDirectoryHandle(`.${pool}`)
	).getDirectoryHandle(".opaque");
	let count = 0;
	for await (const [, handle] of (
		opaque as unknown as {
			entries(): AsyncIterable<[string, FileSystemHandle]>;
		}
	).entries()) {
		if (handle.kind === "file") count += 1;
	}
	return count;
}

/**
 * Hold every slot as a dying Worker would, then let go one handle every
 * `stepMs`. Resolves once all are held; `released` settles when all are free.
 */
async function ghostHolds(
	pool: string,
	stepMs: number,
): Promise<{ readonly released: Promise<void> }> {
	const ghost = new Worker(
		new URL("./sahpool-ghost-worker.ts", import.meta.url),
		{ type: "module", name: "edgeproc-sahpool-ghost" },
	);
	let freed: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		freed = resolve;
	});
	await new Promise<void>((resolve, reject) => {
		ghost.onmessage = ({ data }) => {
			if (data.error) reject(new Error(`ghost failed: ${data.error}`));
			else if (data.held !== undefined) resolve();
			else if (data.released !== undefined) {
				ghost.terminate();
				freed();
			}
		};
		ghost.postMessage({ pool, stepMs } satisfies GhostRequest);
	});
	return { released };
}

const describe = (error: unknown) =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);

async function round(
	name: string,
	pool: string,
	n: number,
): Promise<ReloadRound> {
	const worker = killable("/dist/sql/worker.js", "edgeproc-sql-reload");
	try {
		const victim = await openSqlDatabase(
			{ name },
			{ workerFactory: worker.factory },
		);
		await victim.exec(`INSERT INTO t VALUES (${n}, randomblob(4000))`);
		void victim.close().catch(() => undefined);
		worker.kill();
		await sleep(50);
		// The old Worker's handles, still closing as the new owner sets up.
		const ghost = await ghostHolds(pool, 30);
		const next = await openSqlDatabase({ name });
		await ghost.released;
		try {
			// A write transaction: its rollback journal needs a free slot.
			await next.exec(
				`BEGIN IMMEDIATE; INSERT INTO t VALUES (${-n}, randomblob(4000)); COMMIT;`,
			);
		} finally {
			await next.close();
		}
		return { slots: await slotCount(pool), error: null };
	} catch (error) {
		worker.kill();
		return {
			slots: await slotCount(pool).catch(() => -1),
			error: describe(error),
		};
	}
}

window.runSahPoolReloadProof = async (name, rounds) => {
	const pool = await sqlDatabasePoolName(name);
	const seed = await openSqlDatabase({ name });
	const storage = seed.storage.persistence;
	await seed.exec("CREATE TABLE t(n INTEGER, pad BLOB)");
	await seed.close();
	const initialSlots = await slotCount(pool);
	const results: ReloadRound[] = [];
	for (let n = 1; n <= rounds; n += 1) results.push(await round(name, pool, n));
	const check = await openSqlDatabase({ name });
	const [rows] = await check.query("SELECT count(*) AS n FROM t");
	await check.close();
	await removeSqlDatabase(name);
	return { storage, initialSlots, rounds: results, rows: rows?.n };
};

window.opfsAvailable = () =>
	navigator.storage.getDirectory().then(
		() => true,
		() => false,
	);
