// @vitest-environment node
// The opfs-sahpool slot guards, proven against the pinned build in Node on an
// in-memory OPFS (src/sql/__fixtures__/memoryOpfs.ts models the browser rule
// that a file another handle holds open cannot be removed).
//
// The CI failure these pin ("SAH pool is full. Cannot create file
// …sqlite3-journal"): a reload's new Worker set the pool up while the old
// Worker's handles were still closing; the failed setup deleted the free
// slots; the next setup saw a nonzero capacity and never added any back.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MemoryDirectoryHandle } from "./__fixtures__/memoryOpfs";
import { installMemoryOpfs } from "./__fixtures__/memoryOpfs";
import type { NodeSqlite } from "./__fixtures__/nodeSqlite";
import type { SqlRawDatabase } from "./engine";
import {
	openSqlStorage,
	type SqlStorageDeps,
	sqlDatabasePoolName,
} from "./open";
import { installSahPool, sahPoolSlotsNeeded, TEMP_FILE_SLOTS } from "./sahPool";

let uninstall: () => void = () => undefined;

beforeAll(() => {
	uninstall = installMemoryOpfs();
});

afterAll(() => {
	uninstall();
});

/** A fresh pinned module: what a new Worker (a reload) starts with. */
async function freshSqlite(): Promise<NodeSqlite> {
	vi.resetModules();
	const { loadNodeSqlite } = await import("./__fixtures__/nodeSqlite");
	return loadNodeSqlite();
}

function storageDeps(
	sqlite: NodeSqlite,
	tempStore: "memory" | "file" = "memory",
): SqlStorageDeps<SqlRawDatabase> {
	return {
		openMemory: () => sqlite.openMemory(),
		installPool: (name) => installSahPool(sqlite.module, name),
		locks: undefined,
		warn: () => undefined,
		lockWaitMs: 2_000,
		tempStore,
	};
}

async function slotDirectory(pool: string): Promise<MemoryDirectoryHandle> {
	const root = (await navigator.storage.getDirectory()) as unknown as {
		getDirectoryHandle(name: string): Promise<MemoryDirectoryHandle>;
	};
	return (await root.getDirectoryHandle(`.${pool}`)).getDirectoryHandle(
		".opaque",
	);
}

/** The pool's slot files on disk, as the next setup will find them. */
async function slotFiles(pool: string) {
	const files = [];
	for await (const [, handle] of (await slotDirectory(pool)).entries()) {
		if (handle.kind === "file") files.push(handle);
	}
	return files as unknown as Array<{
		createSyncAccessHandle(): Promise<{ close(): void }>;
	}>;
}

/** What a dying Worker leaves: every slot still held open for a moment. */
async function holdEverySlot(pool: string): Promise<Array<{ close(): void }>> {
	return Promise.all(
		(await slotFiles(pool)).map((file) => file.createSyncAccessHandle()),
	);
}

function write(raw: SqlRawDatabase, value: number): void {
	const db = raw as unknown as { exec(sql: string): unknown };
	db.exec("CREATE TABLE IF NOT EXISTS t(x INTEGER)");
	// journal_mode=DELETE: a write transaction needs a slot for its journal.
	db.exec(`BEGIN IMMEDIATE; INSERT INTO t VALUES (${value}); COMMIT;`);
}

describe("sahPoolSlotsNeeded", () => {
	it("needs the database and its journal, plus temp-file slots by temp_store", () => {
		expect(TEMP_FILE_SLOTS).toEqual({ memory: 0, file: 4 });
		expect(sahPoolSlotsNeeded([], "/a.sqlite3", "memory")).toBe(2);
		expect(sahPoolSlotsNeeded([], "/a.sqlite3", "file")).toBe(6);
	});

	it("counts files already in use once, including a leftover journal", () => {
		expect(
			sahPoolSlotsNeeded(
				["/a.sqlite3", "/a.sqlite3-journal", "/b.sqlite3"],
				"/a.sqlite3",
				"memory",
			),
		).toBe(3);
	});
});

describe("opfs-sahpool slot guards (pinned build, in-memory OPFS)", () => {
	it("tops up a pool with fewer free slots than needed, so the journal can be created", async () => {
		const sqlite = await freshSqlite();
		const name = "short-pool";
		const pool = await sqlDatabasePoolName(name);
		const shrunk = (await installSahPool(sqlite.module, pool)) as unknown as {
			reduceCapacity(n: number): Promise<number>;
			getCapacity(): number;
		};
		// One slot: room for the database file, none for its journal.
		await shrunk.reduceCapacity(shrunk.getCapacity() - 1);
		expect(shrunk.getCapacity()).toBe(1);

		const opened = await openSqlStorage(storageDeps(sqlite), { name });
		try {
			expect(() => write(opened.raw, 1)).not.toThrow();
			expect(await slotFiles(pool)).toHaveLength(2);
		} finally {
			(opened.raw as unknown as { close(): void }).close();
			await opened.release();
		}
	});

	it("resumes a pool a previous operation paused", async () => {
		const sqlite = await freshSqlite();
		const pool = "paused-pool";
		const first = await installSahPool(sqlite.module, pool);
		first.pauseVfs();
		expect(first.isPaused()).toBe(true);
		const again = await installSahPool(sqlite.module, pool);
		expect(again.isPaused()).toBe(false);
		again.pauseVfs();
	});

	it("tops up for temp files when temp_store is FILE (the minimal tier)", async () => {
		const sqlite = await freshSqlite();
		const name = "minimal-tier";
		const pool = await sqlDatabasePoolName(name);
		const shrunk = (await installSahPool(sqlite.module, pool)) as unknown as {
			reduceCapacity(n: number): Promise<number>;
			getCapacity(): number;
		};
		await shrunk.reduceCapacity(shrunk.getCapacity() - 1);
		const opened = await openSqlStorage(storageDeps(sqlite, "file"), { name });
		try {
			expect(await slotFiles(pool)).toHaveLength(6);
		} finally {
			(opened.raw as unknown as { close(): void }).close();
			await opened.release();
		}
	});

	it("a failed setup leaves the pool's slots intact", async () => {
		const owner = await freshSqlite();
		const pool = "failed-setup";
		const first = await installSahPool(owner.module, pool);
		const db = new first.OpfsSAHPoolDb(`/${pool}.sqlite3`);
		write(db as unknown as SqlRawDatabase, 1);
		(db as unknown as { close(): void }).close();
		first.pauseVfs();
		const before = (await slotFiles(pool)).length;

		// Half the slots still held by the dying Worker: setup must fail…
		const held = await holdEverySlot(pool);
		for (const handle of held.slice(0, Math.floor(held.length / 2))) {
			handle.close();
		}
		const newcomer = await freshSqlite();
		await expect(installSahPool(newcomer.module, pool)).rejects.toThrow();
		for (const handle of held) handle.close();

		// …without deleting the slots it could reach.
		expect(await slotFiles(pool)).toHaveLength(before);
		const recovered = await installSahPool(newcomer.module, pool);
		const again = new recovered.OpfsSAHPoolDb(`/${pool}.sqlite3`);
		const rows = (
			again as unknown as {
				selectValue(sql: string): unknown;
			}
		).selectValue("SELECT count(*) FROM t");
		(again as unknown as { close(): void }).close();
		expect(rows).toBe(1);
	});

	it("open → kill the Worker mid-close → reopen, 8 rounds: slot count stable, never full", async () => {
		const name = "reload-rounds";
		const pool = await sqlDatabasePoolName(name);
		const seed = await openSqlStorage(storageDeps(await freshSqlite()), {
			name,
		});
		write(seed.raw, 0);
		(seed.raw as unknown as { close(): void }).close();
		await seed.release();
		const capacity = (await slotFiles(pool)).length;
		const counts: number[] = [];
		for (let round = 1; round <= 8; round += 1) {
			// The killed Worker's handles close a few at a time, after the new
			// Worker already holds the owner lock and has started setup.
			const held = await holdEverySlot(pool);
			const releasing = (async () => {
				for (const handle of held) {
					await new Promise((resolve) => setTimeout(resolve, 5));
					handle.close();
				}
			})();
			const opened = await openSqlStorage(storageDeps(await freshSqlite()), {
				name,
			});
			await releasing;
			try {
				expect(opened.storage.persistence).toBe("opfs");
				write(opened.raw, round);
			} finally {
				(opened.raw as unknown as { close(): void }).close();
				await opened.release();
			}
			counts.push((await slotFiles(pool)).length);
		}
		expect(counts).toEqual(Array.from({ length: 8 }, () => capacity));
	});
});
