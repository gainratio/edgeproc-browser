// @vitest-environment node
// How the engine Worker holds its SQLite chunk database: the OPFS pool and its
// owner lock (#39) are taken for ONE operation and released after it, so every
// tab gets persistent storage in turn instead of one tab owning it for life.
// When OPFS is refused, the Worker keeps one in-memory database for its life,
// says so in a typed status, and never touches the legacy (IndexedDB) stores.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { FakeLocks } from "../sql/__fixtures__/fakeLocks";
import {
	loadNodeSqlite,
	type NodeSqlite,
} from "../sql/__fixtures__/nodeSqlite";
import type { SqlRawDatabase } from "../sql/engine";
import {
	openSqlStorage,
	poolOwnerLock,
	sqlDatabasePoolName,
} from "../sql/open";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import { ChunkDatabase, chunkDatabaseName } from "./chunkDatabase";
import {
	catalogMetaChunkHash,
	catalogMetaChunkSize,
	chunkBytes,
} from "./fixtures";
import type { LegacySnapshot, LegacySource } from "./migration";

let sqlite: NodeSqlite;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
});

const HASH = catalogMetaChunkHash();
const SIZE = catalogMetaChunkSize();

/** One "OPFS file": a node connection that survives the engine's close().
 * An in-memory connection always answers journal_mode "memory", so the
 * DELETE-journal check the seam runs on OPFS files is answered as a file would. */
function persistentFile(): SqlRawDatabase {
	const raw = sqlite.openMemory();
	return {
		...(raw.pointer === undefined ? {} : { pointer: raw.pointer }),
		exec: (options) => raw.exec(options),
		prepare: (sql) => raw.prepare(sql),
		transaction: (qualifier, work) => raw.transaction(qualifier, work),
		selectObjects: (sql, bind) =>
			sql === "PRAGMA journal_mode = DELETE"
				? [{ journal_mode: "delete" }]
				: raw.selectObjects(sql, bind),
		close: () => undefined,
	};
}

function legacy(data: LegacySnapshot): LegacySource & { reads: number } {
	const source = {
		label: "legacy",
		reads: 0,
		read: () => {
			source.reads += 1;
			return Promise.resolve(data);
		},
		remove: () => Promise.resolve(),
	};
	return source;
}

function host(options: {
	readonly file?: SqlRawDatabase;
	readonly install?: () => Promise<never>;
	readonly sources?: ReadonlyArray<LegacySource>;
	readonly locks?: FakeLocks;
	readonly withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}) {
	const locks = options.locks ?? new FakeLocks();
	const file = options.file ?? persistentFile();
	const sources = vi.fn(() => options.sources ?? []);
	const warn = vi.fn();
	const opens = { count: 0 };
	const database = new ChunkDatabase({
		namespace: "shop",
		...(options.withLock === undefined ? {} : { withLock: options.withLock }),
		open: (name) => {
			opens.count += 1;
			return openSqlStorage<SqlRawDatabase>(
				{
					openMemory: () => sqlite.openMemory(),
					installPool:
						options.install ??
						(async () => ({
							OpfsSAHPoolDb: class {
								public constructor() {
									// biome-ignore lint/correctness/noConstructorReturn: test double
									return file;
								}
							} as unknown as new (
								path: string,
							) => SqlRawDatabase,
						})),
					locks,
					warn,
					lockWaitMs: 20,
				},
				{ name, fallback: "memory" },
			);
		},
		memoryProfile: MEMORY_PROFILES.lite,
		legacySources: sources,
		warn,
	});
	return { database, locks, sources, warn, opens };
}

describe("ChunkDatabase", () => {
	it("names one database per cache namespace", () => {
		expect(chunkDatabaseName("shop")).toBe("shop-chunks");
		expect(() => chunkDatabaseName("Bad")).toThrow(TypeError);
	});

	it("holds the pool owner lock for one operation only", async () => {
		const { database, locks } = host({});
		const lock = poolOwnerLock(await sqlDatabasePoolName("shop-chunks"));
		const storage = await database.run(async (_store, status) => {
			expect(locks.isHeld(lock)).toBe(true);
			return status;
		});
		expect(storage).toMatchObject({ persistence: "opfs" });
		await database.idle();
		expect(locks.isHeld(lock)).toBe(false);
	});

	it("serves a burst of queued operations in ONE session under ONE cross-tab lock", async () => {
		const held: string[] = [];
		const { database, opens, locks } = host({
			withLock: async (operation) => {
				held.push("lock");
				try {
					return await operation();
				} finally {
					held.push("unlock");
				}
			},
		});
		const lock = poolOwnerLock(await sqlDatabasePoolName("shop-chunks"));
		const results = await Promise.all(
			[1, 2, 3, 4].map((value) =>
				database.run(async () => {
					expect(locks.isHeld(lock)).toBe(true);
					return value;
				}),
			),
		);
		expect(results).toEqual([1, 2, 3, 4]);
		await database.idle();
		expect(opens.count).toBe(1);
		expect(held).toEqual(["lock", "unlock"]);
		expect(locks.isHeld(lock)).toBe(false);
		await database.run(() => Promise.resolve());
		expect(opens.count).toBe(2);
	});

	it("runs queued read-only operations concurrently, writes alone", async () => {
		const { database } = host({});
		const log: string[] = [];
		const step = (name: string) => async () => {
			log.push(`${name}:start`);
			await new Promise((resolve) => setTimeout(resolve, 5));
			log.push(`${name}:end`);
		};
		await Promise.all([
			database.run(step("write")),
			database.run(step("readA"), { shared: true }),
			database.run(step("readB"), { shared: true }),
		]);
		expect(log).toEqual([
			"write:start",
			"write:end",
			"readA:start",
			"readB:start",
			"readA:end",
			"readB:end",
		]);
	});

	it("fails only the operation that threw, not the rest of its burst", async () => {
		const { database } = host({});
		const outcomes = await Promise.allSettled([
			database.run(() => Promise.reject(new Error("one bad read"))),
			database.run(() => Promise.resolve("fine")),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual([
			"rejected",
			"fulfilled",
		]);
	});

	it("keeps data across operations, like a reload of another tab would see it", async () => {
		const { database } = host({});
		await database.run((store) =>
			store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE),
		);
		const seen = await database.run((store) => store.hasChunk(HASH));
		expect(seen).toBe(true);
	});

	it("commits verified chunks even when the operation fails (resumable sync)", async () => {
		const { database } = host({});
		await expect(
			database.run(async (store) => {
				await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
				throw new Error("network dropped");
			}),
		).rejects.toThrow("network dropped");
		expect(await database.run((store) => store.hasChunk(HASH))).toBe(true);
	});

	it("migrates the legacy stores once, on the first persistent operation", async () => {
		const source = legacy({
			chunks: [{ hash: HASH, body: chunkBytes(HASH) }],
			manifests: [],
			pointers: [],
		});
		const { database } = host({ sources: [source] });
		expect(await database.run((store) => store.hasChunk(HASH))).toBe(true);
		await database.run(() => Promise.resolve());
		expect(source.reads).toBe(1);
	});

	it("a failed migration warns and the operation still runs (it re-downloads)", async () => {
		const broken: LegacySource = {
			label: "broken",
			read: () => Promise.reject(new Error("legacy unreadable")),
			remove: () => Promise.resolve(),
		};
		const { database, warn } = host({ sources: [broken] });
		expect(await database.run(() => Promise.resolve("synced"))).toBe("synced");
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/legacy unreadable/),
		);
	});

	it("falls back to ONE in-memory database for the Worker's life when OPFS is refused", async () => {
		const refused = Object.assign(new Error("UnknownError"), {
			name: "UnknownError",
		});
		const { database, sources } = host({
			install: () => Promise.reject(refused),
		});
		const first = await database.run(async (store, status) => {
			await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
			return status;
		});
		expect(first).toEqual({
			persistence: "memory",
			reason: "opfs-unavailable",
			detail: "UnknownError",
		});
		const second = await database.run(async (store, status) => ({
			status,
			present: await store.hasChunk(HASH),
		}));
		expect(second).toEqual({ status: first, present: true });
		expect(sources).not.toHaveBeenCalled();
	});

	it("reports pool-in-use when a foreign context holds the pool past the wait", async () => {
		const locks = new FakeLocks();
		const lock = poolOwnerLock(await sqlDatabasePoolName("shop-chunks"));
		let free: () => void = () => undefined;
		void locks.request(
			lock,
			{},
			() =>
				new Promise<void>((resolve) => {
					free = resolve;
				}),
		);
		const { database } = host({ locks });
		const status = await database.run((_store, storage) =>
			Promise.resolve(storage),
		);
		expect(status).toMatchObject({
			persistence: "memory",
			reason: "pool-in-use",
		});
		free();
	});
});

describe("ChunkDatabase refusals", () => {
	it("closes the file and frees the pool when the engine refuses the connection", async () => {
		const file = persistentFile();
		let closed = 0;
		const wrong: SqlRawDatabase = {
			...file,
			selectObjects: (sql, bind) =>
				sql.includes("sqlite_version()")
					? [{ sqlite: "0.0.0", vector: "0", fts5: 1 }]
					: file.selectObjects(sql, bind),
			close: () => {
				closed += 1;
			},
		};
		const { database, locks } = host({ file: wrong });
		await expect(database.run(() => Promise.resolve())).rejects.toThrow(
			/unexpected SQLite runtime/,
		);
		await database.idle();
		expect(closed).toBe(1);
		expect(
			locks.isHeld(poolOwnerLock(await sqlDatabasePoolName("shop-chunks"))),
		).toBe(false);
	});

	it("reports a non-Error migration failure too", async () => {
		const broken: LegacySource = {
			label: "broken",
			read: () => Promise.reject("plain string"),
			remove: () => Promise.resolve(),
		};
		const { database, warn } = host({ sources: [broken] });
		await database.run(() => Promise.resolve());
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/plain string/));
	});
});
