// @vitest-environment node
//
// Moving a database out of an opfs-sahpool another SQLite build left behind.
// Recovery runs on the real pinned build: a hot rollback journal must be
// played back by SQLite, never copied past. The orchestration (lock, pool
// handles, import, optional removal) is driven with fakes for the parts that
// only a browser has; test/browser/sql-legacy.spec.ts proves it on real OPFS.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import { FakeLocks } from "./__fixtures__/fakeLocks";
import { loadNodeSqlite, type NodeSqlite } from "./__fixtures__/nodeSqlite";
import { SqlEngine } from "./engine";
import {
	asLegacySahPool,
	createJournalRecovery,
	isSqlRecoveryModule,
	type LegacyMigrationDeps,
	type LegacySahPool,
	migrateLegacySahPool,
	opfsPoolExists,
} from "./legacy";
import type { SqlImportOptions } from "./types";
import { SqlImportRejectedError, SqlStorageUnavailableError } from "./types";

let sqlite: NodeSqlite;
let recover: (database: Uint8Array, journal?: Uint8Array) => Uint8Array;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
	recover = createJournalRecovery(sqlite.module);
});

const PAGE = 4096;

/** A database file: `customers` with 40 rows whose name is `${prefix}${id}`. */
function databaseBytes(prefix: string): Uint8Array {
	const raw = sqlite.openMemory();
	try {
		raw.exec({
			sql: `PRAGMA page_size = ${PAGE};
				CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
				WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
				INSERT INTO customers SELECT i, '${prefix}' || i FROM n;`,
		});
		return sqlite.serializer.serialize(raw);
	} finally {
		raw.close();
	}
}

/**
 * The rollback journal SQLite writes before changing `original` (format:
 * sqlite.org/fileformat.html#the_rollback_journal): a header naming the page
 * and sector size, then each original page with its number and checksum. A
 * crash after the database file was overwritten leaves exactly this behind.
 */
function rollbackJournal(original: Uint8Array): Uint8Array {
	const sector = 512;
	const nonce = 0x5eed1e55;
	const pages = original.byteLength / PAGE;
	const record = PAGE + 8;
	const journal = new Uint8Array(sector + pages * record);
	const view = new DataView(journal.buffer);
	journal.set([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
	view.setUint32(8, pages);
	view.setUint32(12, nonce);
	view.setUint32(16, pages);
	view.setUint32(20, sector);
	view.setUint32(24, PAGE);
	for (let page = 1; page <= pages; page += 1) {
		const data = original.subarray((page - 1) * PAGE, page * PAGE);
		let checksum = nonce;
		for (let i = PAGE - 200; i > 0; i -= 200) {
			checksum = (checksum + (data[i] ?? 0)) >>> 0;
		}
		const at = sector + (page - 1) * record;
		view.setUint32(at, page);
		journal.set(data, at + 4);
		view.setUint32(at + 4 + PAGE, checksum);
	}
	return journal;
}

function names(bytes: Uint8Array): string[] {
	const raw = sqlite.openMemory();
	const release = sqlite.serializer.deserialize(raw, "main", bytes, true);
	try {
		return raw
			.selectObjects("SELECT name FROM customers ORDER BY id")
			.map((row) => String(row.name));
	} finally {
		raw.close();
		release();
	}
}

describe("createJournalRecovery (real SQLite)", () => {
	it("plays a hot rollback journal back: the committed state, not the torn file", () => {
		const committed = databaseBytes("kept-");
		const torn = databaseBytes("torn-");
		const recovered = recover(torn, rollbackJournal(committed));
		expect(names(recovered)[0]).toBe("kept-1");
		expect(recovered).toEqual(committed);
		// What a raw byte copy would have migrated instead:
		expect(names(torn)[0]).toBe("torn-1");
	});

	it("returns the file unchanged when there is no journal", () => {
		const file = databaseBytes("plain-");
		expect(recover(file)).toBe(file);
	});

	it("ignores a journal that is not hot (zeroed header, as journal_mode=PERSIST leaves it)", () => {
		const file = databaseBytes("now-");
		const stale = rollbackJournal(databaseBytes("old-"));
		stale.fill(0, 0, 28);
		expect(names(recover(file, stale))[0]).toBe("now-1");
	});

	it("leaves no copy of the personal data behind in the scratch filesystem", () => {
		const module = sqlite.module;
		if (!isSqlRecoveryModule(module)) throw new Error("not a recovery module");
		const file = "/tmp/edgeproc-legacy-probe.sqlite3";
		const fixed = createJournalRecovery(module, () => file);
		for (const prefix of ["first-", "second-"]) {
			const committed = databaseBytes(prefix);
			const recovered = fixed(
				databaseBytes("torn-"),
				rollbackJournal(committed),
			);
			expect(names(recovered)[0]).toBe(`${prefix}1`);
			for (const leftover of [file, `${file}-journal`]) {
				expect(
					() =>
						new module.oo1.DB({ filename: leftover, flags: "w", vfs: "unix" }),
				).toThrow(/unable to open/);
			}
		}
	});
});

function domError(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

/** An opfs-sahpool the way sqlite3.mjs's PoolUtil exposes it. */
class FakePool implements LegacySahPool {
	readonly files = new Map<string, Uint8Array>();
	readonly log: string[] = [];
	paused = false;
	removed = false;

	public getFileNames(): string[] {
		this.log.push("list");
		return [...this.files.keys()];
	}

	public exportFile(name: string): Uint8Array {
		if (this.paused) throw new Error("paused");
		this.log.push(`export ${name}`);
		const bytes = this.files.get(name);
		if (bytes === undefined) throw new Error(`File not found: ${name}`);
		return bytes.slice();
	}

	public isPaused(): boolean {
		return this.paused;
	}

	public async unpauseVfs(): Promise<this> {
		this.log.push("unpause");
		this.paused = false;
		return this;
	}

	public pauseVfs(): this {
		this.log.push("pause");
		this.paused = true;
		return this;
	}

	public async removeVfs(): Promise<boolean> {
		this.log.push("remove");
		this.removed = true;
		this.paused = true;
		return true;
	}
}

interface Harness {
	readonly deps: LegacyMigrationDeps;
	readonly pool: FakePool;
	readonly locks: FakeLocks;
	readonly imports: Array<{ bytes: Uint8Array; options?: SqlImportOptions }>;
	installs: number;
	installError: Error | undefined;
	exists: boolean;
}

function harness(overrides: Partial<LegacyMigrationDeps> = {}): Harness {
	const pool = new FakePool();
	const state = {
		pool,
		locks: new FakeLocks(),
		imports: [] as Harness["imports"],
		installs: 0,
		installError: undefined as Error | undefined,
		exists: true,
	};
	const deps: LegacyMigrationDeps = {
		locks: state.locks,
		lockWaitMs: 20,
		ownPool: "edgeproc-sql-new",
		poolExists: async () => state.exists && !pool.removed,
		installPool: async () => {
			state.installs += 1;
			if (state.installError !== undefined) throw state.installError;
			return pool;
		},
		recover: (database, journal) => recover(database, journal),
		importDatabase: (bytes, options) => {
			state.imports.push({ bytes, ...(options ? { options } : {}) });
			return { byteLength: bytes.byteLength, applicationId: 0, userVersion: 0 };
		},
		...overrides,
	};
	return Object.assign(state, { deps });
}

const REQUEST = { fromPool: "amlfilter-workstation", fromFile: "/kyc.sqlite3" };

describe("migrateLegacySahPool", () => {
	it("recovers, imports and keeps the legacy pool by default, handles released", async () => {
		const h = harness();
		const committed = databaseBytes("kyc-");
		h.pool.files.set("/kyc.sqlite3", databaseBytes("torn-"));
		h.pool.files.set("/kyc.sqlite3-journal", rollbackJournal(committed));
		const result = await migrateLegacySahPool(h.deps, REQUEST);
		expect(result).toEqual({
			status: "migrated",
			result: {
				byteLength: committed.byteLength,
				applicationId: 0,
				userVersion: 0,
			},
			recoveredJournal: true,
			legacy: "kept",
		});
		expect(h.imports[0]?.bytes).toEqual(committed);
		expect(h.pool.removed).toBe(false);
		expect(h.pool.paused).toBe(true);
		expect(h.locks.isHeld("amlfilter-workstation-owner")).toBe(false);
	});

	it("holds the Web Lock for the whole read and import", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		let heldDuringImport = false;
		const deps: LegacyMigrationDeps = {
			...h.deps,
			importDatabase: (bytes) => {
				heldDuringImport = h.locks.isHeld("amlfilter-workstation-owner");
				return {
					byteLength: bytes.byteLength,
					applicationId: 0,
					userVersion: 0,
				};
			},
		};
		expect(await migrateLegacySahPool(deps, REQUEST)).toMatchObject({
			status: "migrated",
			recoveredJournal: false,
		});
		expect(heldDuringImport).toBe(true);
	});

	it("passes import options through (allowTriggersAndViews for a workstation schema)", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		const importOptions = { allowTriggersAndViews: true, maxBytes: 1 << 20 };
		await migrateLegacySahPool(h.deps, { ...REQUEST, importOptions });
		expect(h.imports[0]?.options).toEqual(importOptions);
	});

	it("removes the legacy pool only on request, and only after the import", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		let removedBeforeImport: boolean | undefined;
		const deps: LegacyMigrationDeps = {
			...h.deps,
			importDatabase: (bytes) => {
				removedBeforeImport = h.pool.removed;
				return {
					byteLength: bytes.byteLength,
					applicationId: 0,
					userVersion: 0,
				};
			},
		};
		const result = await migrateLegacySahPool(deps, {
			...REQUEST,
			removeLegacy: true,
		});
		expect(result).toMatchObject({ status: "migrated", legacy: "removed" });
		expect(removedBeforeImport).toBe(false);
		expect(h.pool.removed).toBe(true);
	});

	it("never deletes a pool that holds other databases: reports it shared", async () => {
		// removeVfs() deletes EVERY file in the pool, not just fromFile.
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		h.pool.files.set("/kyc.sqlite3-journal", new Uint8Array(0));
		h.pool.files.set("/audit.sqlite3", databaseBytes("audit-"));
		const result = await migrateLegacySahPool(h.deps, {
			...REQUEST,
			removeLegacy: true,
		});
		expect(result).toMatchObject({ status: "migrated", legacy: "shared" });
		expect(h.pool.removed).toBe(false);
		expect(h.pool.files.has("/audit.sqlite3")).toBe(true);
	});

	it("reports the legacy pool kept when removal left its directory behind", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		const deps: LegacyMigrationDeps = {
			...h.deps,
			poolExists: async () => true,
		};
		const result = await migrateLegacySahPool(deps, {
			...REQUEST,
			removeLegacy: true,
		});
		expect(result).toMatchObject({ status: "migrated", legacy: "kept" });
	});

	it("never removes the legacy pool when the import is refused", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		const deps: LegacyMigrationDeps = {
			...h.deps,
			importDatabase: () => {
				throw new SqlImportRejectedError("unsafe-schema", "trigger");
			},
		};
		await expect(
			migrateLegacySahPool(deps, { ...REQUEST, removeLegacy: true }),
		).rejects.toBeInstanceOf(SqlImportRejectedError);
		expect(h.pool.removed).toBe(false);
		expect(h.pool.paused).toBe(true);
		expect(h.locks.isHeld("amlfilter-workstation-owner")).toBe(false);
	});

	it("is in-use, touching nothing, while another migrator holds the lock", async () => {
		const h = harness();
		let release: () => void = () => undefined;
		void h.locks.request("amlfilter-workstation-owner", {}, () => {
			return new Promise<void>((done) => {
				release = done;
			});
		});
		expect(await migrateLegacySahPool(h.deps, REQUEST)).toEqual({
			status: "in-use",
		});
		expect(h.installs).toBe(0);
		release();
	});

	it("is in-use when an old-build tab still holds the pool's access handles", async () => {
		const h = harness();
		h.installError = domError("NoModificationAllowedError");
		expect(await migrateLegacySahPool(h.deps, REQUEST)).toEqual({
			status: "in-use",
		});
		expect(h.imports).toEqual([]);
		expect(h.locks.isHeld("amlfilter-workstation-owner")).toBe(false);
	});

	it("rethrows an install failure that is not contention", async () => {
		const h = harness();
		h.installError = new Error("quota exceeded");
		await expect(migrateLegacySahPool(h.deps, REQUEST)).rejects.toThrow(
			"quota exceeded",
		);
	});

	it("is absent without installing (and so creating) a missing pool", async () => {
		const h = harness();
		h.exists = false;
		expect(await migrateLegacySahPool(h.deps, REQUEST)).toEqual({
			status: "absent",
		});
		expect(h.installs).toBe(0);
	});

	it("is absent when the pool holds no such file, and releases the handles", async () => {
		const h = harness();
		h.pool.files.set("/other.sqlite3", databaseBytes("x-"));
		expect(await migrateLegacySahPool(h.deps, REQUEST)).toEqual({
			status: "absent",
		});
		expect(h.pool.paused).toBe(true);
	});

	it("refuses a legacy WAL file rather than migrate without its frames", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		h.pool.files.set("/kyc.sqlite3-wal", new Uint8Array(32));
		await expect(migrateLegacySahPool(h.deps, REQUEST)).rejects.toThrow(/WAL/);
		expect(h.imports).toEqual([]);
		expect(h.pool.paused).toBe(true);
	});

	it("reacquires a pool an earlier migration in this Worker paused", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		await migrateLegacySahPool(h.deps, REQUEST);
		h.pool.log.length = 0;
		await migrateLegacySahPool(h.deps, REQUEST);
		expect(h.pool.log[0]).toBe("unpause");
	});

	it("uses the lock name it is given", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		let seen = false;
		const deps: LegacyMigrationDeps = {
			...h.deps,
			importDatabase: (bytes) => {
				seen = h.locks.isHeld("custom-lock");
				return {
					byteLength: bytes.byteLength,
					applicationId: 0,
					userVersion: 0,
				};
			},
		};
		await migrateLegacySahPool(deps, { ...REQUEST, lockName: "custom-lock" });
		expect(seen).toBe(true);
	});

	it("runs without Web Locks (the pool's own handles still exclude old tabs)", async () => {
		const h = harness({ locks: undefined });
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		expect(await migrateLegacySahPool(h.deps, REQUEST)).toMatchObject({
			status: "migrated",
		});
	});

	it("refuses to migrate into a database that is not on OPFS", async () => {
		const h = harness({ ownPool: undefined });
		await expect(migrateLegacySahPool(h.deps, REQUEST)).rejects.toBeInstanceOf(
			SqlStorageUnavailableError,
		);
		expect(h.installs).toBe(0);
	});

	it("refuses its own pool and unsafe pool names", async () => {
		const h = harness();
		await expect(
			migrateLegacySahPool(h.deps, {
				...REQUEST,
				fromPool: "edgeproc-sql-new",
			}),
		).rejects.toThrow(TypeError);
		for (const fromPool of ["", "..", "a/b", ".hidden"]) {
			await expect(
				migrateLegacySahPool(h.deps, { ...REQUEST, fromPool }),
			).rejects.toThrow(TypeError);
		}
		await expect(
			migrateLegacySahPool(h.deps, { ...REQUEST, fromFile: "" }),
		).rejects.toThrow(TypeError);
		expect(h.installs).toBe(0);
	});

	it("rethrows a lock failure that is not a timeout", async () => {
		const h = harness({
			locks: {
				request: () => Promise.reject(new Error("locks broken")),
			},
		});
		await expect(migrateLegacySahPool(h.deps, REQUEST)).rejects.toThrow(
			"locks broken",
		);
	});

	it("does not mistake an AbortError from inside the lock for a busy lock", async () => {
		const h = harness();
		h.pool.files.set("/kyc.sqlite3", databaseBytes("kyc-"));
		const deps: LegacyMigrationDeps = {
			...h.deps,
			importDatabase: () => {
				throw domError("AbortError");
			},
		};
		await expect(migrateLegacySahPool(deps, REQUEST)).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});

describe("opfsPoolExists", () => {
	const root = (outcome: "found" | Error) => ({
		getDirectoryHandle: async (name: string) => {
			if (outcome !== "found") throw outcome;
			return { name };
		},
	});

	it("looks for the pool's directory without creating it", async () => {
		const calls: unknown[] = [];
		const spy = {
			getDirectoryHandle: async (name: string, options?: unknown) => {
				calls.push([name, options]);
				return {};
			},
		};
		expect(await opfsPoolExists("amlfilter-workstation", spy)).toBe(true);
		expect(calls).toEqual([[".amlfilter-workstation", { create: false }]]);
	});

	it("is false for NotFoundError and rethrows anything else", async () => {
		expect(await opfsPoolExists("p", root(domError("NotFoundError")))).toBe(
			false,
		);
		await expect(
			opfsPoolExists("p", root(domError("SecurityError"))),
		).rejects.toThrow("SecurityError");
		expect(await opfsPoolExists("p", root("found"))).toBe(true);
	});
});

describe("migration through the engine (row-identical copy)", () => {
	it("imports the recovered legacy file row for row, triggers included", async () => {
		const legacy = sqlite.openMemory();
		legacy.exec({
			sql: `CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT, risk REAL, doc BLOB);
				CREATE TABLE match_events(id INTEGER PRIMARY KEY, customer_id INTEGER, at TEXT);
				CREATE TRIGGER match_events_no_update BEFORE UPDATE ON match_events
				BEGIN SELECT RAISE(ABORT, 'match_events is append-only'); END;
				CREATE TRIGGER match_events_no_delete BEFORE DELETE ON match_events
				WHEN EXISTS (SELECT 1 FROM customers WHERE id = OLD.customer_id)
				BEGIN SELECT RAISE(ABORT, 'append-only'); END;
				INSERT INTO customers VALUES (1, 'Ada', 0.25, x'00ff10'), (2, NULL, NULL, NULL);
				INSERT INTO match_events VALUES (7, 1, '2026-10-04');`,
		});
		const file = sqlite.serializer.serialize(legacy);
		const expected = {
			customers: legacy.selectObjects("SELECT * FROM customers ORDER BY id"),
			events: legacy.selectObjects("SELECT * FROM match_events ORDER BY id"),
		};
		legacy.close();

		const target = new SqlEngine(sqlite.openMemory(), {
			storage: { persistence: "memory", reason: "requested" },
			memoryProfile: MEMORY_PROFILES.lite,
			serializer: sqlite.serializer,
		});
		const h = harness({
			importDatabase: (bytes, options) => target.importDatabase(bytes, options),
		});
		h.pool.files.set("/kyc.sqlite3", file);
		await expect(migrateLegacySahPool(h.deps, REQUEST)).rejects.toMatchObject({
			reason: "unsafe-schema",
		});
		await migrateLegacySahPool(h.deps, {
			...REQUEST,
			importOptions: { allowTriggersAndViews: true },
		});
		expect(target.query("SELECT * FROM customers ORDER BY id")).toEqual(
			expected.customers,
		);
		expect(target.query("SELECT * FROM match_events ORDER BY id")).toEqual(
			expected.events,
		);
		expect(() => target.exec("UPDATE match_events SET at = 'x'")).toThrow(
			/append-only/,
		);
		target.close();
	});
});

describe("refusing modules that lack what migration needs", () => {
	const METHODS = [
		"getFileNames",
		"exportFile",
		"isPaused",
		"unpauseVfs",
		"pauseVfs",
		"removeVfs",
	] as const;
	const util = (omit: ReadonlyArray<string>) =>
		Object.fromEntries(
			METHODS.filter((name) => !omit.includes(name)).map((name) => [
				name,
				() => undefined,
			]),
		);

	it("accepts a PoolUtil with every method migration calls", () => {
		const complete = util([]);
		expect(asLegacySahPool(complete)).toBe(complete);
	});

	it("refuses a PoolUtil missing any of them, naming each", () => {
		expect(() => asLegacySahPool(util(["exportFile", "removeVfs"]))).toThrow(
			new TypeError("opfs-sahpool PoolUtil lacks exportFile, removeVfs"),
		);
	});

	it("refuses to build journal recovery on a module without the unix VFS file APIs", () => {
		expect(() => createJournalRecovery({})).toThrow(
			new TypeError("sqlite-wasm module lacks the unix VFS file APIs"),
		);
	});
});
