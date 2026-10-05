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
import {
	ChunkDatabase,
	chunkDatabaseName,
	persistedSqlPoolExists,
} from "./chunkDatabase";
import {
	catalogMetaChunkHash,
	catalogMetaChunkSize,
	chunkBytes,
} from "./fixtures";
import type { LegacySnapshot, LegacySource } from "./migration";
import { RollbackError } from "./sync";
import type { VersionPointer } from "./types";

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

function legacy(
	data: LegacySnapshot,
): LegacySource & { reads: number; removed: number } {
	const source = {
		label: "legacy",
		reads: 0,
		removed: 0,
		read: () => {
			source.reads += 1;
			return Promise.resolve(data);
		},
		readPointers: () => Promise.resolve(data.pointers),
		remove: () => {
			source.removed += 1;
			return Promise.resolve();
		},
	};
	return source;
}

function pointer(sequence: number): VersionPointer {
	return {
		manifest_hash: "d".repeat(64),
		version: `v${sequence}`,
		sequence,
		signature: `sig-${sequence}`,
	};
}

function host(options: {
	readonly file?: SqlRawDatabase;
	readonly install?: () => Promise<never>;
	readonly sources?: ReadonlyArray<LegacySource>;
	readonly locks?: FakeLocks;
	readonly withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly persistedPoolExists?: (name: string) => Promise<boolean>;
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
					tempStore: "memory",
				},
				{ name, fallback: "memory" },
			);
		},
		memoryProfile: MEMORY_PROFILES.lite,
		legacySources: sources,
		persistedPoolExists:
			options.persistedPoolExists ?? (() => Promise.resolve(false)),
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
			readPointers: () => Promise.resolve([pointer(5)]),
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
		expect(sources).toHaveBeenCalledTimes(1);
	});

	it("fails CLOSED on pool-in-use: never an empty in-memory floor beside a persisted one", async () => {
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
		await expect(
			database.run((store) => store.promote(pointer(1))),
		).rejects.toMatchObject({
			name: "SqlStorageUnavailableError",
			reason: "pool-in-use",
		});
		free();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const status = await database.run((_store, storage) =>
			Promise.resolve(storage),
		);
		expect(status).toMatchObject({ persistence: "opfs" });
	});
});

describe("ChunkDatabase anti-rollback floor (each rollback attempt)", () => {
	const refused = () =>
		Promise.reject(
			Object.assign(new Error("UnknownError"), { name: "UnknownError" }),
		);

	it("fails CLOSED when OPFS errors but a persisted chunk pool exists: its floor is on disk", async () => {
		// Was: any non-contention install error fell back to memory with floor
		// -1, so a rollback pointer was accepted beside the real SQLite floor.
		const asked: string[] = [];
		const { database } = host({
			install: refused,
			persistedPoolExists: (name) => {
				asked.push(name);
				return Promise.resolve(true);
			},
		});
		await expect(
			database.run((store) => store.promote(pointer(1))),
		).rejects.toMatchObject({
			name: "SqlStorageUnavailableError",
			reason: "opfs-unavailable",
		});
		expect(asked).toEqual(["shop-chunks"]);
	});

	it("in memory mode, propagates an error that is not an unreadable legacy floor", async () => {
		const { database, sources } = host({ install: refused });
		sources.mockImplementation(() => {
			throw new Error("legacy sources unavailable");
		});
		await expect(
			database.run((store) => store.promote(pointer(1))),
		).rejects.toThrow("legacy sources unavailable");
	});

	it("fails CLOSED when it cannot tell whether a persisted chunk pool exists", async () => {
		const { database } = host({
			install: refused,
			persistedPoolExists: () => Promise.reject(new Error("io")),
		});
		await expect(
			database.run((store) => store.promote(pointer(1))),
		).rejects.toThrow("io");
	});

	it("a migration that fails after reading the floor still imports it, and keeps the legacy store", async () => {
		const broken = Object.assign(
			legacy({ chunks: [], manifests: [], pointers: [pointer(5)] }),
			{
				read: () => Promise.reject(new Error("chunk dir unreadable")),
			},
		);
		const { database, warn } = host({ sources: [broken] });
		await expect(
			database.run((store) => store.promote(pointer(4))),
		).rejects.toBeInstanceOf(RollbackError);
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/chunk dir unreadable/),
		);
		expect(broken.removed).toBe(0);
		await database.run((store) => store.promote(pointer(6)));
	});

	it("fails CLOSED when the legacy floor itself cannot be read", async () => {
		const unreadable = Object.assign(
			legacy({ chunks: [], manifests: [], pointers: [] }),
			{
				readPointers: () => Promise.reject(new Error("idb broken")),
			},
		);
		const { database } = host({ sources: [unreadable] });
		const promoted = vi.fn();
		await expect(
			database.run(async (store) => {
				promoted();
				await store.promote(pointer(1));
			}),
		).rejects.toThrow(/legacy rollback floor unavailable.*idb broken/);
		expect(promoted).not.toHaveBeenCalled();
	});

	it("an explicit reset (clear) still runs when the legacy floor is unreadable, and deletes it", async () => {
		const unreadable = Object.assign(
			legacy({ chunks: [], manifests: [], pointers: [] }),
			{
				readPointers: () => Promise.reject(new Error("idb broken")),
			},
		);
		const { database } = host({ sources: [unreadable] });
		await database.run((store) => store.clear(), { reset: true });
		expect(unreadable.removed).toBe(1);
	});

	it("in-memory mode honours the 0.2.x IndexedDB floor, and never deletes it", async () => {
		const source = legacy({
			chunks: [],
			manifests: [],
			pointers: [pointer(5)],
		});
		const { database } = host({ install: refused, sources: [source] });
		await expect(
			database.run((store) => store.promote(pointer(4))),
		).rejects.toBeInstanceOf(RollbackError);
		await database.run((store) => store.promote(pointer(5)));
		expect(source.removed).toBe(0);
		expect(source.reads).toBe(0);
	});

	it("in-memory mode fails CLOSED when the legacy floor cannot be read", async () => {
		const unreadable = Object.assign(
			legacy({ chunks: [], manifests: [], pointers: [] }),
			{
				readPointers: () => Promise.reject(new Error("idb broken")),
			},
		);
		const { database } = host({ install: refused, sources: [unreadable] });
		await expect(
			database.run((store) => store.promote(pointer(1))),
		).rejects.toThrow(/legacy rollback floor unavailable/);
	});

	it("a re-download (tamper eviction) never touches the floor", async () => {
		const { database } = host({});
		await database.run(async (store) => {
			await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
			await store.promote(pointer(3), [HASH]);
		});
		await database.run((store) =>
			store.getChunk(HASH, SIZE + 1).catch(() => undefined),
		);
		expect(await database.run((store) => store.hasChunk(HASH))).toBe(false);
		expect(await database.run((store) => store.readFloor())).toBe(3);
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
			readPointers: () => Promise.resolve([]),
			remove: () => Promise.resolve(),
		};
		const { database, warn } = host({ sources: [broken] });
		await database.run(() => Promise.resolve());
		expect(warn).toHaveBeenCalledWith(expect.stringMatching(/plain string/));
	});
});

describe("persistedSqlPoolExists", () => {
	const dir = (found: ReadonlySet<string>, error = "NotFoundError") => ({
		getDirectoryHandle: (name: string) =>
			found.has(name)
				? Promise.resolve(dir(new Set()))
				: Promise.reject(new DOMException(name, error)),
	});

	it("finds the named database's pool directory", async () => {
		const pool = await sqlDatabasePoolName("shop-chunks");
		const root = dir(new Set([`.${pool}`]));
		expect(await persistedSqlPoolExists("shop-chunks", async () => root)).toBe(
			true,
		);
		expect(await persistedSqlPoolExists("other", async () => root)).toBe(false);
	});

	it("reads a refused OPFS root as no pool, and rethrows any other error", async () => {
		expect(
			await persistedSqlPoolExists("shop-chunks", () =>
				Promise.reject(new DOMException("refused", "UnknownError")),
			),
		).toBe(false);
		await expect(
			persistedSqlPoolExists("shop-chunks", async () =>
				dir(new Set(), "UnknownError"),
			),
		).rejects.toThrow();
	});
});
