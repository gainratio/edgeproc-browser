// @vitest-environment node
// The pinned build's opfs-sahpool locking, proven in-process on an in-memory
// OPFS. Two handles on one database file in the same thread must behave like
// os_unix.c's connections sharing an inode: a writer blocks another writer
// with SQLITE_BUSY (upstream 9e2caaa382), the busy handler never sleeps the
// thread that would have to resolve that contention (upstream c9dd4d88e4),
// and the reserved lock is visible to the other handle (9168a6f1be).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installMemoryOpfs } from "./__fixtures__/memoryOpfs";
import { loadNodeSqlite, type NodeSqlite } from "./__fixtures__/nodeSqlite";

interface Oo1Db {
	exec(sql: string): unknown;
	selectValue(sql: string): unknown;
	close(): void;
}

interface SahPool {
	readonly OpfsSAHPoolDb: new (file: string) => Oo1Db;
	removeVfs(): Promise<unknown>;
}

let uninstall: () => void = () => undefined;
let sqlite: NodeSqlite;

beforeAll(async () => {
	uninstall = installMemoryOpfs();
	sqlite = await loadNodeSqlite();
});

afterAll(() => {
	uninstall();
});

async function twoHandles(name: string): Promise<{
	readonly a: Oo1Db;
	readonly b: Oo1Db;
	readonly done: () => Promise<void>;
}> {
	const pool = (await sqlite.module.installOpfsSAHPoolVfs({
		name,
	})) as unknown as SahPool;
	const a = new pool.OpfsSAHPoolDb("/shared.sqlite3");
	a.exec("CREATE TABLE t(x INTEGER)");
	const b = new pool.OpfsSAHPoolDb("/shared.sqlite3");
	return {
		a,
		b,
		done: async () => {
			a.close();
			b.close();
			await pool.removeVfs();
		},
	};
}

function busyMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	return "succeeded";
}

describe("opfs-sahpool locking between handles in one thread", () => {
	it("refuses a second writer with SQLITE_BUSY while the first holds RESERVED", async () => {
		const { a, b, done } = await twoHandles("lock-writers");
		a.exec("BEGIN IMMEDIATE");
		a.exec("INSERT INTO t VALUES (1)");
		expect(busyMessage(() => b.exec("BEGIN IMMEDIATE"))).toMatch(/BUSY/);
		a.exec("COMMIT");
		b.exec("BEGIN IMMEDIATE");
		b.exec("INSERT INTO t VALUES (2)");
		b.exec("COMMIT");
		expect(a.selectValue("SELECT count(*) FROM t")).toBe(2);
		await done();
	});

	it("lets a reader see only committed rows while another handle writes", async () => {
		const { a, b, done } = await twoHandles("lock-reader");
		a.exec("BEGIN IMMEDIATE");
		a.exec("INSERT INTO t VALUES (1)");
		expect(b.selectValue("SELECT count(*) FROM t")).toBe(0);
		a.exec("COMMIT");
		expect(b.selectValue("SELECT count(*) FROM t")).toBe(1);
		await done();
	});

	it("never sleeps in the busy handler: a 3 s busy_timeout still fails fast", async () => {
		const { a, b, done } = await twoHandles("lock-sleep");
		b.exec("PRAGMA busy_timeout = 3000");
		a.exec("BEGIN IMMEDIATE");
		const started = performance.now();
		expect(busyMessage(() => b.exec("BEGIN IMMEDIATE"))).toMatch(/BUSY/);
		// Sleeping cannot free a lock held in this same thread; a VFS that
		// inherited the default xSleep would block here for the full 3 s.
		expect(performance.now() - started).toBeLessThan(1_000);
		a.exec("ROLLBACK");
		await done();
	});
});
