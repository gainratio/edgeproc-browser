// @vitest-environment node
// One-time migration from the 0.2.x stores (OPFS chunk files + the IndexedDB
// rollback floor) into SQLite: one transaction, verified, then the old stores
// are deleted. Crash-resumable, idempotent, and the floor only ever rises.

import { beforeAll, describe, expect, it } from "vitest";
import {
	loadNodeSqlite,
	type NodeSqlite,
} from "../sql/__fixtures__/nodeSqlite";
import { SqlEngine } from "../sql/engine";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import { chunkBytes, signedChunkRefs } from "./fixtures";
import {
	importLegacyFloor,
	LegacyFloorUnavailableError,
	type LegacySnapshot,
	type LegacySource,
	migrateLegacyStores,
} from "./migration";
import { type ChunkSqlConnection, SqliteCacheStore } from "./sqliteStore";
import { RollbackError } from "./sync";
import type { VersionPointer } from "./types";

let sqlite: NodeSqlite;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
});

function engine(): SqlEngine {
	return new SqlEngine(sqlite.openMemory(), {
		storage: { persistence: "memory", reason: "requested" },
		memoryProfile: MEMORY_PROFILES.lite,
	});
}

function pointer(sequence: number, version = `v${sequence}`): VersionPointer {
	return {
		manifest_hash: "c".repeat(64),
		version,
		sequence,
		signature: `sig-${version}`,
	};
}

const REFS = [
	...new Map(signedChunkRefs().map((ref) => [ref.hash, ref])).values(),
].slice(0, 4);

function snapshot(
	pointers: ReadonlyArray<VersionPointer | null>,
): LegacySnapshot {
	return {
		chunks: REFS.map((ref) => ({ hash: ref.hash, body: chunkBytes(ref.hash) })),
		manifests: [],
		pointers,
	};
}

/** A legacy store whose read/remove can be made to fail like a crash. */
class FakeSource implements LegacySource {
	public readonly label = "fake";
	public removed = false;
	public failRead = false;
	public failRemove = false;
	public data: LegacySnapshot;
	public constructor(data: LegacySnapshot) {
		this.data = data;
	}
	public failPointers = false;
	public readPointers(): Promise<ReadonlyArray<VersionPointer | null>> {
		if (this.failPointers) return Promise.reject(new Error("floor unreadable"));
		return Promise.resolve(this.removed ? [] : this.data.pointers);
	}
	public read(): Promise<LegacySnapshot> {
		if (this.failRead) return Promise.reject(new Error("crash during read"));
		return Promise.resolve(
			this.removed ? { chunks: [], manifests: [], pointers: [] } : this.data,
		);
	}
	public remove(): Promise<void> {
		if (this.failRemove)
			return Promise.reject(new Error("crash during delete"));
		this.removed = true;
		return Promise.resolve();
	}
}

function chunkCount(db: SqlEngine): number {
	return Number(db.query("SELECT count(*) AS n FROM chunk")[0]?.n);
}

describe("migrateLegacyStores", () => {
	it("copies verified chunks and the floor, then deletes the old store", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const source = new FakeSource(snapshot([pointer(4), null]));
		const report = await migrateLegacyStores(store, [source]);
		expect(report).toMatchObject({
			state: "migrated",
			copiedChunks: 4,
			skippedChunks: 0,
			floor: 4,
		});
		expect(chunkCount(db)).toBe(4);
		expect(await store.readActive()).toEqual(pointer(4));
		expect(source.removed).toBe(true);
		expect(store.migrationState()).toBe("done");
		for (const ref of REFS) {
			expect((await store.getChunk(ref.hash, ref.size)).byteLength).toBe(
				ref.size,
			);
		}
	});

	it("skips a legacy chunk that fails verification instead of importing it", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const data = snapshot([]);
		const [first, second] = data.chunks;
		if (first === undefined || second === undefined) throw new Error("fixture");
		const source = new FakeSource({
			...data,
			chunks: [
				{ hash: first.hash, body: second.body },
				...data.chunks.slice(1),
			],
		});
		const report = await migrateLegacyStores(store, [source]);
		expect(report).toMatchObject({ copiedChunks: 3, skippedChunks: 1 });
		expect(await store.hasChunk(first.hash)).toBe(false);
	});

	it("is a no-op once done", async () => {
		const store = SqliteCacheStore.open(engine());
		await migrateLegacyStores(store, [new FakeSource(snapshot([pointer(1)]))]);
		const again = new FakeSource(snapshot([pointer(9)]));
		expect(await migrateLegacyStores(store, [again])).toMatchObject({
			state: "already-done",
		});
		expect(again.removed).toBe(false);
		expect(await store.readFloor()).toBe(1);
	});

	it("resumes after a crash between the copy and the delete", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const source = new FakeSource(snapshot([pointer(6)]));
		source.failRemove = true;
		await expect(migrateLegacyStores(store, [source])).rejects.toThrow(
			"crash during delete",
		);
		expect(store.migrationState()).toBe("copied");
		expect(chunkCount(db)).toBe(4);
		expect(await store.readFloor()).toBe(6);

		source.failRemove = false;
		const reopened = SqliteCacheStore.open(db);
		expect(await migrateLegacyStores(reopened, [source])).toMatchObject({
			state: "migrated",
		});
		expect(source.removed).toBe(true);
		expect(reopened.migrationState()).toBe("done");
		expect(chunkCount(db)).toBe(4);
	});

	it("copies nothing when the copy transaction dies midway (the floor already holds), then completes", async () => {
		const db = engine();
		let crash = true;
		const crashing: ChunkSqlConnection = {
			exec: (sql, bind) => {
				if (crash && sql.includes("INSERT INTO legacy_migration"))
					throw new Error("power cut");
				return db.exec(sql, bind);
			},
			query: (sql, bind) => db.query(sql, bind),
			immediate: (work) => db.immediate(work),
		};
		const store = SqliteCacheStore.open(crashing);
		const source = new FakeSource(snapshot([pointer(3)]));
		await expect(migrateLegacyStores(store, [source])).rejects.toThrow(
			"power cut",
		);
		expect(chunkCount(db)).toBe(0);
		// The floor is imported in its own transaction BEFORE the copy, so a
		// copy that dies still leaves the legacy floor in force (was -1 here).
		expect(await store.readFloor()).toBe(3);
		expect(source.removed).toBe(false);

		crash = false;
		expect(await migrateLegacyStores(store, [source])).toMatchObject({
			state: "migrated",
			floor: 3,
		});
	});

	it("does not mark done or delete when a legacy store cannot be read, but keeps its floor", async () => {
		const store = SqliteCacheStore.open(engine());
		const source = new FakeSource(snapshot([pointer(2)]));
		source.failRead = true;
		await expect(migrateLegacyStores(store, [source])).rejects.toThrow(
			"crash during read",
		);
		expect(store.migrationState()).toBe("none");
		expect(source.removed).toBe(false);
		expect(await store.readFloor()).toBe(2);
		await expect(store.promote(pointer(1))).rejects.toBeInstanceOf(
			RollbackError,
		);
	});

	it("refuses with LegacyFloorUnavailableError, changing nothing, when the floor cannot be read", async () => {
		const store = SqliteCacheStore.open(engine());
		const source = new FakeSource(snapshot([pointer(2)]));
		source.failPointers = true;
		await expect(migrateLegacyStores(store, [source])).rejects.toBeInstanceOf(
			LegacyFloorUnavailableError,
		);
		expect(await store.readFloor()).toBe(-1);
		expect(source.removed).toBe(false);
	});
});

describe("a floor that cannot be WRITTEN", () => {
	it("refuses with LegacyFloorUnavailableError when raising the floor throws (BUSY, I/O)", async () => {
		// Was: the write error escaped as an ordinary error, the caller took it
		// for a failed bulk copy, and the operation ran with no legacy floor.
		const store = SqliteCacheStore.open(engine());
		store.raiseLegacyFloor = () => {
			throw new Error("SQLITE_BUSY");
		};
		const source = new FakeSource(snapshot([pointer(2)]));
		await expect(importLegacyFloor(store, [source])).rejects.toBeInstanceOf(
			LegacyFloorUnavailableError,
		);
		await expect(migrateLegacyStores(store, [source])).rejects.toBeInstanceOf(
			LegacyFloorUnavailableError,
		);
		expect(source.removed).toBe(false);
	});
});

describe("the rollback floor across migration", () => {
	it("never lowers an existing SQLite floor", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(10));
		await migrateLegacyStores(store, [new FakeSource(snapshot([pointer(5)]))]);
		expect(await store.readFloor()).toBe(10);
		expect(await store.readActive()).toEqual(pointer(10));
		await expect(store.promote(pointer(7))).rejects.toBeInstanceOf(
			RollbackError,
		);
	});

	it("raises the floor to the highest legacy pointer across every slot and source", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(2));
		await migrateLegacyStores(store, [
			new FakeSource(snapshot([pointer(8), pointer(20)])),
			new FakeSource(snapshot([pointer(12)])),
		]);
		expect(await store.readFloor()).toBe(20);
		await expect(store.promote(pointer(19))).rejects.toBeInstanceOf(
			RollbackError,
		);
		await expect(store.promote(pointer(20, "other"))).rejects.toBeInstanceOf(
			RollbackError,
		);
		await store.promote(pointer(20));
	});

	it("keeps a floor with no identity when legacy slots disagree at the same sequence", async () => {
		const store = SqliteCacheStore.open(engine());
		await migrateLegacyStores(store, [
			new FakeSource(snapshot([pointer(9, "a"), pointer(9, "b")])),
		]);
		expect(await store.readFloor()).toBe(9);
		expect(await store.readActive()).toBeNull();
		await expect(store.promote(pointer(9, "a"))).rejects.toBeInstanceOf(
			RollbackError,
		);
		await store.promote(pointer(10));
	});

	it("forgets the identity when legacy and SQLite disagree at the same sequence", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(4, "sqlite"));
		await migrateLegacyStores(store, [
			new FakeSource(snapshot([pointer(4, "legacy")])),
		]);
		expect(await store.readFloor()).toBe(4);
		await expect(store.promote(pointer(4, "sqlite"))).rejects.toBeInstanceOf(
			RollbackError,
		);
		await store.promote(pointer(5));
	});
});

describe("migration refusals", () => {
	it("skips a bad hash name, a non-zstd body and a manifest that fails its address", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const [ref] = REFS;
		if (ref === undefined) throw new Error("fixture");
		const manifest = new TextEncoder().encode("{}");
		const report = await migrateLegacyStores(store, [
			new FakeSource({
				chunks: [
					{ hash: "not-a-hash", body: chunkBytes(ref.hash) },
					{ hash: "e".repeat(64), body: new Uint8Array([1, 2, 3]) },
				],
				manifests: [{ hash: "f".repeat(64), body: manifest }],
				pointers: [],
			}),
		]);
		expect(report).toMatchObject({ copiedChunks: 0, skippedChunks: 2 });
		expect(Number(db.query("SELECT count(*) AS n FROM manifest")[0]?.n)).toBe(
			0,
		);
	});

	it("refuses to delete the legacy store when a copied chunk is not actually there", async () => {
		const db = engine();
		const lossy: ChunkSqlConnection = {
			exec: (sql, bind) =>
				sql.startsWith("INSERT OR IGNORE INTO chunk")
					? { changes: 0, lastInsertRowid: 0 }
					: db.exec(sql, bind),
			query: (sql, bind) => db.query(sql, bind),
			immediate: (work) => db.immediate(work),
		};
		const source = new FakeSource(snapshot([pointer(1)]));
		await expect(
			migrateLegacyStores(SqliteCacheStore.open(lossy), [source]),
		).rejects.toThrow(/missing after commit/);
		expect(source.removed).toBe(false);
	});
});

describe("legacy floor merge, every case", () => {
	const disagreeing = (sequence: number) => [
		null,
		pointer(sequence, "a"),
		pointer(sequence, "b"),
	];

	it("keeps a higher SQLite floor untouched when legacy slots disagree below it", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(9));
		await migrateLegacyStores(store, [
			new FakeSource(snapshot(disagreeing(4))),
		]);
		expect(await store.readActive()).toEqual(pointer(9));
		await store.promote(pointer(9));
	});

	it("forgets the SQLite identity when legacy slots disagree AT its floor", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(4));
		await migrateLegacyStores(store, [
			new FakeSource(snapshot(disagreeing(4))),
		]);
		await expect(store.promote(pointer(4))).rejects.toBeInstanceOf(
			RollbackError,
		);
		await store.promote(pointer(5));
	});

	it("keeps the active pointer when legacy agrees with it exactly", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(4));
		await migrateLegacyStores(store, [new FakeSource(snapshot([pointer(4)]))]);
		expect(await store.readActive()).toEqual(pointer(4));
		await store.promote(pointer(4));
	});

	it("restores the active pointer from legacy when only the floor survived", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(4));
		await store.clearActiveIf(pointer(4));
		await migrateLegacyStores(store, [new FakeSource(snapshot([pointer(4)]))]);
		expect(await store.readActive()).toEqual(pointer(4));
	});

	it("never lets a sequence-less legacy pointer displace an active release", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(1));
		const legacy = {
			manifest_hash: "c".repeat(64),
			version: "v0",
			signature: "s",
		};
		await migrateLegacyStores(store, [
			new FakeSource(snapshot([legacy as unknown as VersionPointer])),
		]);
		expect(await store.readActive()).toEqual(pointer(1));
	});

	it("imports a legacy manifest that matches its address", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const body = new TextEncoder().encode('{"files":[]}');
		const hash = Buffer.from(
			await crypto.subtle.digest("SHA-256", body),
		).toString("hex");
		await migrateLegacyStores(store, [
			new FakeSource({ chunks: [], manifests: [{ hash, body }], pointers: [] }),
		]);
		expect(await store.getManifest(hash)).toEqual(body);
	});
});
