// The 0.2.x stores, read once and deleted. This is the ONLY module allowed to
// touch IndexedDB, and it only reads and deletes: it never creates a database
// and never writes a value (see storageGuard.test.ts).

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
	indexedDbLegacySource,
	type LegacyDirectory,
	opfsLegacySource,
	resolveIndexedDbLayout,
	settle,
	transactionDone,
} from "./legacyStores";
import type { VersionPointer } from "./types";

const ENCODER = new TextEncoder();
const HASH = "1".repeat(64);
const MANIFEST = "2".repeat(64);
const POINTER: VersionPointer = {
	manifest_hash: MANIFEST,
	version: "v3",
	sequence: 3,
	signature: "sig",
};

function request<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function seed(
	factory: IDBFactory,
	database: string,
	store: string,
	entries: ReadonlyArray<[string, unknown]>,
): Promise<void> {
	const open = factory.open(database, 1);
	open.onupgradeneeded = () => open.result.createObjectStore(store);
	const db = await request(open);
	const tx = db.transaction(store, "readwrite");
	for (const [key, value] of entries) tx.objectStore(store).put(value, key);
	await new Promise((resolve) => {
		tx.oncomplete = resolve;
	});
	db.close();
}

async function keys(factory: IDBFactory, database: string, store: string) {
	const db = await request(factory.open(database));
	const all = await request(
		db.transaction(store).objectStore(store).getAllKeys(),
	);
	db.close();
	return all;
}

describe("indexedDbLegacySource", () => {
	const layout = resolveIndexedDbLayout({}, "edgeproc-browser-cache");

	it("reads chunks, manifests and the floor, then deletes only its own keys", async () => {
		const factory = new IDBFactory();
		await seed(factory, layout.database, layout.store, [
			[`chunk:${HASH}`, new Uint8Array([1, 2])],
			[`manifest:${MANIFEST}`, new Uint8Array([3]).buffer],
			["active", ENCODER.encode(JSON.stringify(POINTER))],
			["someone-else", "keep me"],
		]);
		const source = indexedDbLegacySource(layout, factory);
		const snapshot = await source.read();
		expect(snapshot.chunks).toEqual([
			{ hash: HASH, body: new Uint8Array([1, 2]) },
		]);
		expect(snapshot.manifests).toEqual([
			{ hash: MANIFEST, body: new Uint8Array([3]) },
		]);
		expect(snapshot.pointers).toEqual([POINTER]);
		await source.remove();
		expect(await keys(factory, layout.database, layout.store)).toEqual([
			"someone-else",
		]);
	});

	it("honours a consumer's legacy layout and an object-valued pointer", async () => {
		const factory = new IDBFactory();
		const custom = resolveIndexedDbLayout({
			database: "aml-filter-signed-bundles-v1",
			store: "entries",
			separator: "/",
		});
		await seed(factory, custom.database, custom.store, [
			[`chunk/${HASH}`, new Uint8Array([9])],
			["active", POINTER],
		]);
		const snapshot = await indexedDbLegacySource(custom, factory).read();
		expect(snapshot.chunks.map((chunk) => chunk.hash)).toEqual([HASH]);
		expect(snapshot.pointers).toEqual([POINTER]);
	});

	it("never creates a database that does not exist", async () => {
		const factory = new IDBFactory();
		const source = indexedDbLegacySource(layout, factory);
		expect(await source.read()).toEqual({
			chunks: [],
			manifests: [],
			pointers: [],
		});
		await source.remove();
		expect(await factory.databases()).toEqual([]);
	});

	it("ignores a database without the store, and malformed values", async () => {
		const factory = new IDBFactory();
		await seed(factory, layout.database, "unrelated", []);
		expect(
			(await indexedDbLegacySource(layout, factory).read()).chunks,
		).toEqual([]);
		const other = new IDBFactory();
		await seed(other, layout.database, layout.store, [
			[`chunk:${HASH}`, "not bytes"],
			["chunk:short", new Uint8Array([1])],
			["active", ENCODER.encode("{not json")],
		]);
		expect(await indexedDbLegacySource(layout, other).read()).toEqual({
			chunks: [],
			manifests: [],
			pointers: [null],
		});
	});

	it("refuses an invalid legacy layout", () => {
		expect(() => resolveIndexedDbLayout({ database: "Bad Name" })).toThrow(
			TypeError,
		);
		expect(() =>
			resolveIndexedDbLayout({ separator: "|" as unknown as ":" }),
		).toThrow(TypeError);
	});
});

class FakeFile {
	public bytes: Uint8Array;
	public constructor(bytes: Uint8Array) {
		this.bytes = bytes;
	}
	public getFile(): Promise<Blob> {
		return Promise.resolve(new Blob([this.bytes.slice()]));
	}
}

class FakeDir implements LegacyDirectory {
	public readonly dirs = new Map<string, FakeDir>();
	public readonly files = new Map<string, FakeFile>();
	public getDirectoryHandle(name: string): Promise<FakeDir> {
		const dir = this.dirs.get(name);
		return dir === undefined
			? Promise.reject(new DOMException("missing", "NotFoundError"))
			: Promise.resolve(dir);
	}
	public getFileHandle(name: string): Promise<FakeFile> {
		const file = this.files.get(name);
		return file === undefined
			? Promise.reject(new DOMException("missing", "NotFoundError"))
			: Promise.resolve(file);
	}
	public async *keys(): AsyncIterableIterator<string> {
		yield* this.files.keys();
	}
	public removeEntry(name: string): Promise<void> {
		if (!this.dirs.delete(name) && !this.files.delete(name)) {
			return Promise.reject(new DOMException("missing", "NotFoundError"));
		}
		return Promise.resolve();
	}
}

describe("opfsLegacySource", () => {
	function legacyRoot(): FakeDir {
		const root = new FakeDir();
		const chunk = new FakeDir();
		chunk.files.set(HASH, new FakeFile(new Uint8Array([7, 7])));
		chunk.files.set("not-a-hash", new FakeFile(new Uint8Array([1])));
		const manifest = new FakeDir();
		manifest.files.set(MANIFEST, new FakeFile(new Uint8Array([5])));
		root.dirs.set("chunk", chunk);
		root.dirs.set("manifest", manifest);
		root.files.set(
			"active.a",
			new FakeFile(ENCODER.encode(JSON.stringify(POINTER))),
		);
		root.files.set("active.b", new FakeFile(ENCODER.encode("garbage")));
		root.files.set("mutation.lock", new FakeFile(new Uint8Array()));
		root.files.set("app-owned-file", new FakeFile(new Uint8Array([1])));
		return root;
	}

	it("reads the origin-root layout and every pointer slot", async () => {
		const snapshot = await opfsLegacySource(async () => legacyRoot()).read();
		expect(snapshot.chunks).toEqual([
			{ hash: HASH, body: new Uint8Array([7, 7]) },
		]);
		expect(snapshot.manifests).toEqual([
			{ hash: MANIFEST, body: new Uint8Array([5]) },
		]);
		expect(snapshot.pointers).toEqual([null, POINTER, null]);
	});

	it("deletes only the 0.2.x entries, idempotently", async () => {
		const root = legacyRoot();
		const source = opfsLegacySource(async () => root);
		await source.remove();
		await source.remove();
		expect([...root.dirs.keys()]).toEqual([]);
		expect([...root.files.keys()]).toEqual(["app-owned-file"]);
	});

	it("reads nothing from an empty root", async () => {
		expect(await opfsLegacySource(async () => new FakeDir()).read()).toEqual({
			chunks: [],
			manifests: [],
			pointers: [null, null, null],
		});
	});

	it("propagates a removal failure that is not 'already gone'", async () => {
		const root = legacyRoot();
		root.removeEntry = () =>
			Promise.reject(new DOMException("held", "NoModificationAllowedError"));
		await expect(opfsLegacySource(async () => root).remove()).rejects.toThrow(
			"held",
		);
	});
});

describe("legacy readers fail closed on unexpected errors", () => {
	it("propagates an IndexedDB open failure that is not a missing database", async () => {
		const failure = new DOMException("disk", "UnknownError");
		const factory = {
			open: () => {
				const request = { error: failure } as unknown as IDBOpenDBRequest;
				queueMicrotask(() => request.onerror?.(new Event("error")));
				return request;
			},
		} as unknown as IDBFactory;
		await expect(
			indexedDbLegacySource(resolveIndexedDbLayout(), factory).read(),
		).rejects.toBe(failure);
	});

	it("rejects a request error and an aborted delete transaction", async () => {
		const error = new DOMException("x", "DataError");
		const request = { error } as unknown as IDBRequest<number>;
		const pending = settle(request);
		request.onerror?.(new Event("error"));
		await expect(pending).rejects.toBe(error);
		const tx = { error: null } as unknown as IDBTransaction;
		const done = transactionDone(tx);
		tx.onabort?.(new Event("abort"));
		await expect(done).rejects.toThrow(/aborted/);
	});

	it("ignores non-string keys in a legacy object store", async () => {
		const factory = new IDBFactory();
		const layout = resolveIndexedDbLayout();
		await seed(factory, layout.database, layout.store, [
			[7 as unknown as string, new Uint8Array([1])],
		]);
		expect(
			(await indexedDbLegacySource(layout, factory).read()).chunks,
		).toEqual([]);
	});

	it("skips oversized OPFS objects and pointers instead of buffering them", async () => {
		const root = new FakeDir();
		const chunk = new FakeDir();
		chunk.files.set(HASH, new FakeFile(new Uint8Array(2 * 1024 * 1024 + 1)));
		root.dirs.set("chunk", chunk);
		root.files.set("active", new FakeFile(new Uint8Array(16 * 1024 + 1)));
		const snapshot = await opfsLegacySource(async () => root).read();
		expect(snapshot.chunks).toEqual([]);
		expect(snapshot.pointers).toEqual([null, null, null]);
	});

	it("treats a file where a directory was expected as absent, but rethrows other errors", async () => {
		const root = new FakeDir();
		root.getDirectoryHandle = () =>
			Promise.reject(new DOMException("file", "TypeMismatchError"));
		expect((await opfsLegacySource(async () => root).read()).chunks).toEqual(
			[],
		);
		root.getDirectoryHandle = () =>
			Promise.reject(new DOMException("io", "UnknownError"));
		await expect(opfsLegacySource(async () => root).read()).rejects.toThrow(
			"io",
		);
		const files = new FakeDir();
		files.getFileHandle = () =>
			Promise.reject(new DOMException("io", "UnknownError"));
		await expect(opfsLegacySource(async () => files).read()).rejects.toThrow(
			"io",
		);
	});

	it("reads a REFUSED OPFS root as no legacy store (no 0.2.x OPFS cache can exist there)", async () => {
		const refusedRoot = () =>
			Promise.reject(new DOMException("refused", "UnknownError"));
		const source = opfsLegacySource(refusedRoot);
		expect(await source.readPointers()).toEqual([]);
		expect(await source.read()).toEqual({
			chunks: [],
			manifests: [],
			pointers: [],
		});
		await source.remove();
	});

	it("reads the real OPFS root by default", async () => {
		const root = new FakeDir();
		vi.stubGlobal("navigator", {
			storage: { getDirectory: () => Promise.resolve(root) },
		});
		try {
			expect((await opfsLegacySource().read()).pointers).toEqual([
				null,
				null,
				null,
			]);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
