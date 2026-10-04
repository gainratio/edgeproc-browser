// @vitest-environment node
// The SQLite chunk store, on the SAME pinned sqlite3.wasm the Worker ships
// (loaded in Node). One table of verbatim zstd chunks, one row holding the
// active pointer and the anti-rollback floor. Every read re-verifies.

import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import {
	loadNodeSqlite,
	type NodeSqlite,
} from "../sql/__fixtures__/nodeSqlite";
import { SqlEngine } from "../sql/engine";
import { MEMORY_PROFILES } from "../sqlite/memoryProfile";
import {
	catalogMetaChunkHash,
	catalogMetaChunkSize,
	chunkBytes,
	signedChunkRefs,
} from "./fixtures";
import { IntegrityError } from "./integrity";
import { SqliteCacheStore } from "./sqliteStore";
import { RollbackError } from "./sync";
import type { VersionPointer } from "./types";

let sqlite: NodeSqlite;
beforeAll(async () => {
	sqlite = await loadNodeSqlite();
});

const HASH = catalogMetaChunkHash();
const SIZE = catalogMetaChunkSize();
const MANIFEST_HASH = "a".repeat(64);

function engine(): SqlEngine {
	return new SqlEngine(sqlite.openMemory(), {
		storage: { persistence: "memory", reason: "requested" },
		memoryProfile: MEMORY_PROFILES.lite,
	});
}

function pointer(sequence: number, version = `v${sequence}`): VersionPointer {
	return {
		manifest_hash: MANIFEST_HASH,
		version,
		sequence,
		signature: `sig-${version}`,
	};
}

/** A VALID zstd frame of the right size whose plaintext is one byte off. */
function forged(hash: string): Uint8Array {
	const plain = Buffer.from(zstdDecompressSync(chunkBytes(hash)));
	plain[0] = (plain[0] ?? 0) ^ 0xff;
	return new Uint8Array(zstdCompressSync(plain));
}

function chunkRows(db: SqlEngine): number {
	return Number(db.query("SELECT count(*) AS n FROM chunk")[0]?.n);
}

describe("SqliteCacheStore", () => {
	it("stores a verified chunk and reads it back, re-verified", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		expect(await store.hasChunk(HASH)).toBe(true);
		const plain = await store.getChunk(HASH, SIZE);
		expect(plain.byteLength).toBe(SIZE);
		expect(chunkRows(db)).toBe(1);
	});

	it("refuses a chunk whose bytes do not hash to its name, storing nothing", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await expect(
			store.putChunkCompressed(HASH, forged(HASH), SIZE),
		).rejects.toBeInstanceOf(IntegrityError);
		await store.flush();
		expect(chunkRows(db)).toBe(0);
	});

	it("rejects a BLOB tampered at rest on read, and evicts it so sync re-fetches", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		await store.flush();
		db.exec("UPDATE chunk SET body = ? WHERE hash = ?", [forged(HASH), HASH]);
		await expect(store.getChunk(HASH, SIZE)).rejects.toBeInstanceOf(
			IntegrityError,
		);
		expect(await store.hasChunk(HASH)).toBe(false);
	});

	it("rejects a BLOB tampered at rest even when its stored size column agrees", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		await store.flush();
		db.exec("UPDATE chunk SET body = zeroblob(64) WHERE hash = ?", [HASH]);
		await expect(store.getChunk(HASH, SIZE)).rejects.toBeInstanceOf(
			IntegrityError,
		);
	});

	it("batches ingest: chunks are visible to hasChunk before and after a flush", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const refs = signedChunkRefs().slice(0, 5);
		for (const ref of refs) {
			await store.putChunkCompressed(ref.hash, chunkBytes(ref.hash), ref.size);
		}
		for (const ref of refs) expect(await store.hasChunk(ref.hash)).toBe(true);
		await store.flush();
		expect(chunkRows(db)).toBe(new Set(refs.map((ref) => ref.hash)).size);
	});

	it("verifies manifests by content address on read", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const bytes = new TextEncoder().encode('{"files":[]}');
		const hash = await store.putManifest(bytes);
		expect(await store.getManifest(hash)).toEqual(bytes);
		db.exec("UPDATE manifest SET body = ? WHERE hash = ?", [
			new TextEncoder().encode('{"files":[1]}'),
			hash,
		]);
		await expect(store.getManifest(hash)).rejects.toBeInstanceOf(
			IntegrityError,
		);
	});
});

describe("SqliteCacheStore active pointer and anti-rollback floor", () => {
	it("promotes and reads the active pointer", async () => {
		const store = SqliteCacheStore.open(engine());
		expect(await store.readActive()).toBeNull();
		await store.promote(pointer(3));
		expect(await store.readActive()).toEqual(pointer(3));
	});

	it("commits the pointer in the same transaction as its pending chunks", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		expect(chunkRows(db)).toBe(0);
		await store.promote(pointer(1), [HASH]);
		expect(chunkRows(db)).toBe(1);
		expect(await store.readActive()).toEqual(pointer(1));
	});

	it("refuses to commit a pointer whose chunks are not all present", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		await expect(
			store.promote(pointer(1), [HASH, "b".repeat(64)]),
		).rejects.toThrow(/missing 1 of 2 chunks/);
		expect(await store.readActive()).toBeNull();
	});

	it("refuses a lower sequence, and a different release at the same sequence", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(5));
		await expect(store.promote(pointer(4))).rejects.toBeInstanceOf(
			RollbackError,
		);
		await expect(store.promote(pointer(5, "forked"))).rejects.toBeInstanceOf(
			RollbackError,
		);
		await store.promote(pointer(5));
		await store.promote(pointer(6));
		expect((await store.readActive())?.sequence).toBe(6);
	});

	it("keeps the floor when the active pointer is cleared", async () => {
		const store = SqliteCacheStore.open(engine());
		await store.promote(pointer(7));
		expect(await store.clearActiveIf(pointer(6))).toBe(false);
		expect(await store.clearActiveIf(pointer(7))).toBe(true);
		expect(await store.readActive()).toBeNull();
		await expect(store.promote(pointer(3))).rejects.toBeInstanceOf(
			RollbackError,
		);
		expect(await store.readFloor()).toBe(7);
	});

	it("makes a lower floor impossible even by direct SQL", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.promote(pointer(9));
		expect(() =>
			db.exec("UPDATE active_pointer SET floor_sequence = 2"),
		).toThrow(/floor may not decrease/);
		expect(await store.readFloor()).toBe(9);
	});

	it("sees another connection's promote on its next read (no stale cache)", async () => {
		const db = engine();
		const tabA = SqliteCacheStore.open(db);
		const tabB = SqliteCacheStore.open(db);
		expect(await tabB.readActive()).toBeNull();
		await tabA.promote(pointer(2));
		expect(await tabB.readActive()).toEqual(pointer(2));
		await expect(tabB.promote(pointer(1))).rejects.toBeInstanceOf(
			RollbackError,
		);
	});

	it("clear() is the explicit reset: chunks, manifests, pointer and floor", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		await store.promote(pointer(4), [HASH]);
		await store.clear();
		expect(chunkRows(db)).toBe(0);
		expect(await store.readActive()).toBeNull();
		expect(await store.readFloor()).toBe(-1);
		await store.promote(pointer(1));
	});
});

describe("SqliteCacheStore eviction", () => {
	it("prunes with DELETE: keeps the active release's chunks and manifest only", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const [keep, drop] = signedChunkRefs().filter(
			(ref, index, all) =>
				all.findIndex((other) => other.hash === ref.hash) === index,
		);
		if (keep === undefined || drop === undefined) throw new Error("fixture");
		await store.putChunkCompressed(keep.hash, chunkBytes(keep.hash), keep.size);
		await store.putChunkCompressed(drop.hash, chunkBytes(drop.hash), drop.size);
		const manifest = new TextEncoder().encode(
			JSON.stringify({ files: [{ chunks: [{ hash: keep.hash }] }] }),
		);
		const old = await store.putManifest(new TextEncoder().encode("{}"));
		const manifestHash = await store.putManifest(manifest);
		await store.promote({ ...pointer(1), manifest_hash: manifestHash }, [
			keep.hash,
		]);
		await store.pruneInactive();
		expect(await store.hasChunk(keep.hash)).toBe(true);
		expect(await store.hasChunk(drop.hash)).toBe(false);
		await expect(store.getManifest(old)).rejects.toThrow(/not in store/);
		expect(await store.getManifest(manifestHash)).toEqual(manifest);
	});

	it("does not prune when the active manifest cannot be read", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		await store.promote(pointer(1), [HASH]);
		await store.pruneInactive();
		expect(await store.hasChunk(HASH)).toBe(true);
	});
});

describe("SqliteCacheStore refusals (every fail-closed branch, witnessed)", () => {
	it("refuses a schema newer than this build instead of guessing", () => {
		const db = engine();
		db.exec("PRAGMA user_version = 99");
		expect(() => SqliteCacheStore.open(db)).toThrow(/schema 99 is newer/);
	});

	it("reopens an existing schema without recreating it", async () => {
		const db = engine();
		await SqliteCacheStore.open(db).promote(pointer(2));
		expect(await SqliteCacheStore.open(db).readActive()).toEqual(pointer(2));
	});

	it("refuses empty and oversized compressed chunks before verifying", async () => {
		const store = SqliteCacheStore.open(engine());
		await expect(
			store.putChunkCompressed(HASH, new Uint8Array(), SIZE),
		).rejects.toThrow(/must not be empty/);
		await expect(
			store.putChunkCompressed(HASH, new Uint8Array(2 * 1024 * 1024 + 1), SIZE),
		).rejects.toThrow(/exceeds the store read cap/);
	});

	it("fails closed on a missing row, a non-BLOB body and an oversized body", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await expect(store.getChunk(HASH, SIZE)).rejects.toThrow(/not in store/);
		db.exec("INSERT INTO chunk(hash, size, body) VALUES (?, ?, 'text')", [
			HASH,
			SIZE,
		]);
		await expect(store.getChunk(HASH, SIZE)).rejects.toThrow(
			/empty or not a BLOB/,
		);
		expect(await store.hasChunk(HASH)).toBe(false);
		db.exec("INSERT INTO chunk(hash, size, body) VALUES (?, ?, zeroblob(?))", [
			HASH,
			SIZE,
			2 * 1024 * 1024 + 1,
		]);
		await expect(store.getChunk(HASH, SIZE)).rejects.toThrow(
			/exceeds the read cap/,
		);
		expect(await store.hasChunk(HASH)).toBe(false);
	});

	it("keeps a row when the failure is not an integrity failure", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		await store.flush();
		await expect(store.getChunk(HASH, Number.NaN)).rejects.toBeInstanceOf(
			IntegrityError,
		);
		expect(await store.hasChunk(HASH)).toBe(false);
	});

	it("refuses an empty manifest and a manifest that is not a BLOB", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await expect(store.putManifest(new Uint8Array())).rejects.toThrow(
			/empty or exceeds/,
		);
		db.exec("INSERT INTO manifest(hash, body) VALUES (?, 'text')", [
			MANIFEST_HASH,
		]);
		await expect(store.getManifest(MANIFEST_HASH)).rejects.toBeInstanceOf(
			IntegrityError,
		);
		await expect(store.getManifest(MANIFEST_HASH)).rejects.toThrow(
			/not in store/,
		);
	});

	it("flushes the ingest buffer by itself at 64 chunks, and ignores a duplicate put", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		const refs = [
			...new Map(signedChunkRefs().map((ref) => [ref.hash, ref])).values(),
		];
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
		for (const ref of refs.filter((ref) => ref.hash !== HASH).slice(0, 63)) {
			await store.putChunkCompressed(ref.hash, chunkBytes(ref.hash), ref.size);
		}
		expect(chunkRows(db)).toBe(64);
	});

	it("does not prune without an active pointer or with a malformed manifest", async () => {
		const malformed = [
			"null",
			"[]",
			'{"files":{}}',
			'{"files":[{"chunks":{}}]}',
			'{"files":[{"chunks":[{"hash":"short"}]}]}',
		];
		const empty = SqliteCacheStore.open(engine());
		await empty.pruneInactive();
		for (const text of malformed) {
			const db = engine();
			const store = SqliteCacheStore.open(db);
			await store.putChunkCompressed(HASH, chunkBytes(HASH), SIZE);
			const hash = await store.putManifest(new TextEncoder().encode(text));
			await store.promote({ ...pointer(1), manifest_hash: hash }, [HASH]);
			await store.pruneInactive();
			expect(await store.hasChunk(HASH)).toBe(true);
		}
	});

	it("reads a corrupted pointer row as no pointer, never as a release", async () => {
		const db = engine();
		const store = SqliteCacheStore.open(db);
		await store.promote(pointer(3));
		db.exec("UPDATE active_pointer SET pointer = '{not json'");
		expect(await store.readActive()).toBeNull();
		db.exec("UPDATE active_pointer SET pointer = 42");
		expect(await store.readActive()).toBeNull();
		expect(await store.readFloor()).toBe(3);
	});

	it("lets a sequenced release replace a sequence-less legacy pointer once", async () => {
		const store = SqliteCacheStore.open(engine());
		const legacy = {
			manifest_hash: MANIFEST_HASH,
			version: "v0",
			signature: "s",
		};
		store.importLegacy({
			chunks: [],
			manifests: [{ hash: MANIFEST_HASH, body: new Uint8Array([1]) }],
			pointers: [legacy as unknown as VersionPointer],
		});
		expect(await store.readFloor()).toBe(-1);
		expect(await store.readActive()).toEqual(legacy);
		await store.promote(pointer(1));
		expect(await store.readFloor()).toBe(1);
	});
});
