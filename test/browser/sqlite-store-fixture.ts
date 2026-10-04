// Real-browser harness for the SQLite chunk store: the BUILT engine Worker
// (dist/) syncing the committed 783-chunk bundle. A "boot" is a fresh Worker
// on the same origin storage, which is what a page reload does to the engine.
// Test code here may touch IndexedDB and OPFS directly: it plays the 0.2.x
// library (seeding legacy stores) and the auditor (listing what exists).

import {
	chunkDatabaseName,
	EngineClient,
	EngineOperationError,
	type EngineSyncResult,
} from "@gainratio/browser";
import { openSqlDatabase } from "@gainratio/browser/sql";

const ORIGIN = "/bundle-origin";
const PUBLIC_KEY = "/bundle-origin/public.key";
const LEGACY_DB = "edgeproc-browser-cache";
const LEGACY_STORE = "content-addressed-cache";

export interface StoreBoot {
	readonly outcome: string;
	readonly syncMs: number;
	readonly readMs: number;
	readonly chunksFetched: number;
	readonly chunksReused: number;
	readonly cacheBackend: string;
	readonly cacheStorage: unknown;
	/** sha256 of every file read, in order: equal digests = equal bytes. */
	readonly digest: string;
}

export interface LegacySeed {
	readonly chunks: ReadonlyArray<{
		readonly hash: string;
		readonly hex: string;
	}>;
	readonly manifest: { readonly hash: string; readonly hex: string } | null;
	readonly opfsPointer: unknown;
	readonly idbPointer: unknown;
}

export interface StorageAudit {
	readonly idbDatabases: ReadonlyArray<string>;
	readonly idbKeys: ReadonlyArray<string>;
	readonly opfsRoot: ReadonlyArray<string> | string;
}

/** The pointer row and chunk count, as one consistent snapshot. */
export interface FloorSnapshot {
	readonly floor: number;
	readonly identity: string | null;
	readonly pointer: string | null;
	readonly chunks: number;
	readonly integrity: string;
}

export interface KillOutcome {
	readonly before: FloorSnapshot;
	readonly after: FloorSnapshot;
	/** The transaction was still running when the Worker was killed. */
	readonly killedMidTransaction: boolean;
	readonly rowsAttempted: number;
}

interface StoreHarness {
	killMidTransaction(
		namespace: string,
		killAfterMs: number,
	): Promise<KillOutcome>;
	boot(namespace: string, paths: ReadonlyArray<string>): Promise<StoreBoot>;
	seedLegacy(seed: LegacySeed): Promise<void>;
	audit(): Promise<StorageAudit>;
	tamperRow(namespace: string, hash: string, hex: string): Promise<number>;
}

declare global {
	interface Window {
		sqliteStore: StoreHarness;
	}
}

function engine(): EngineClient {
	return new EngineClient(
		new Worker(new URL("/dist/engine/worker.js", location.href), {
			type: "module",
		}),
		{ idleTimeoutMs: 120_000 },
	);
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(
		(text.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)),
	);
}

async function digestAll(files: ReadonlyArray<Uint8Array>): Promise<string> {
	const parts = await Promise.all(
		files.map(async (bytes) =>
			[
				...new Uint8Array(
					await crypto.subtle.digest(
						"SHA-256",
						bytes as Uint8Array<ArrayBuffer>,
					),
				),
			]
				.map((value) => value.toString(16).padStart(2, "0"))
				.join(""),
		),
	);
	const all = new TextEncoder().encode(parts.join(","));
	return [...new Uint8Array(await crypto.subtle.digest("SHA-256", all))]
		.map((value) => value.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

async function boot(
	namespace: string,
	paths: ReadonlyArray<string>,
): Promise<StoreBoot> {
	const client = engine();
	const started = performance.now();
	try {
		const result: EngineSyncResult = await client.sync(ORIGIN, PUBLIC_KEY, {
			cacheNamespace: namespace,
		});
		const synced = performance.now();
		const files = await Promise.all(paths.map((path) => client.readFile(path)));
		return {
			outcome: "ok",
			syncMs: synced - started,
			readMs: performance.now() - synced,
			chunksFetched: result.chunksFetched,
			chunksReused: result.chunksReused,
			cacheBackend: result.cacheBackend,
			cacheStorage: result.cacheStorage,
			digest: await digestAll(files),
		};
	} catch (error) {
		return {
			outcome:
				error instanceof EngineOperationError ? error.code : String(error),
			syncMs: performance.now() - started,
			readMs: 0,
			chunksFetched: 0,
			chunksReused: 0,
			cacheBackend: "",
			cacheStorage: null,
			digest: "",
		};
	} finally {
		client.dispose();
	}
}

async function writeOpfs(
	dir: FileSystemDirectoryHandle,
	name: string,
	bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
	const file = await dir.getFileHandle(name, { create: true });
	const writable = await file.createWritable();
	await writable.write(bytes);
	await writable.close();
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** Lay down exactly what @gainratio/browser 0.2.x left behind. */
async function seedLegacy(seed: LegacySeed): Promise<void> {
	if (
		seed.chunks.length > 0 ||
		seed.manifest !== null ||
		seed.opfsPointer !== null
	) {
		await seedOpfs(seed);
	}
	await seedIndexedDb(seed);
}

async function seedOpfs(seed: LegacySeed): Promise<void> {
	const root = await navigator.storage.getDirectory();
	const chunkDir = await root.getDirectoryHandle("chunk", { create: true });
	for (const chunk of seed.chunks) {
		await writeOpfs(chunkDir, chunk.hash, fromHex(chunk.hex));
	}
	if (seed.manifest !== null) {
		const manifestDir = await root.getDirectoryHandle("manifest", {
			create: true,
		});
		await writeOpfs(
			manifestDir,
			seed.manifest.hash,
			fromHex(seed.manifest.hex),
		);
	}
	const encoder = new TextEncoder();
	if (seed.opfsPointer !== null) {
		await writeOpfs(
			root,
			"active.a",
			encoder.encode(JSON.stringify(seed.opfsPointer)),
		);
	}
}

async function seedIndexedDb(seed: LegacySeed): Promise<void> {
	const encoder = new TextEncoder();
	const open = indexedDB.open(LEGACY_DB, 1);
	open.onupgradeneeded = () => open.result.createObjectStore(LEGACY_STORE);
	const db = await idbRequest(open);
	const tx = db.transaction(LEGACY_STORE, "readwrite");
	if (seed.idbPointer !== null) {
		tx.objectStore(LEGACY_STORE).put(
			encoder.encode(JSON.stringify(seed.idbPointer)),
			"active",
		);
	}
	await new Promise((resolve) => {
		tx.oncomplete = resolve;
	});
	db.close();
}

async function audit(): Promise<StorageAudit> {
	const idbDatabases = (await indexedDB.databases()).map(
		(info) => info.name ?? "",
	);
	let idbKeys: string[] = [];
	if (idbDatabases.includes(LEGACY_DB)) {
		const db = await idbRequest(indexedDB.open(LEGACY_DB));
		if (db.objectStoreNames.contains(LEGACY_STORE)) {
			const keys = await idbRequest(
				db.transaction(LEGACY_STORE).objectStore(LEGACY_STORE).getAllKeys(),
			);
			idbKeys = keys.map(String);
		}
		db.close();
	}
	let opfsRoot: string[] | string;
	try {
		const root = await navigator.storage.getDirectory();
		opfsRoot = [];
		for await (const name of (
			root as unknown as { keys(): AsyncIterable<string> }
		).keys()) {
			opfsRoot.push(name);
		}
		opfsRoot.sort();
	} catch (error) {
		opfsRoot = `refused: ${error instanceof Error ? error.name : String(error)}`;
	}
	return { idbDatabases, idbKeys, opfsRoot };
}

/** Same-origin code (an XSS, a compromised dependency) rewrites a chunk row
 * at rest through the public SQL seam. Returns the rows it changed, so the
 * spec can prove the tamper actually landed before trusting the refusal. */
async function tamperRow(
	namespace: string,
	hash: string,
	hex: string,
): Promise<number> {
	const db = await openSqlDatabase({ name: chunkDatabaseName(namespace) });
	try {
		const result = await db.exec("UPDATE chunk SET body = ? WHERE hash = ?", [
			fromHex(hex),
			hash,
		]);
		return result.changes;
	} finally {
		await db.close();
	}
}

async function snapshot(name: string): Promise<FloorSnapshot> {
	const db = await openSqlDatabase({ name });
	try {
		const row = (
			await db.query(
				"SELECT floor_sequence AS floor, floor_identity AS identity, pointer FROM active_pointer WHERE id = 1",
			)
		)[0];
		const chunks = (await db.query("SELECT count(*) AS n FROM chunk"))[0]?.n;
		const integrity = (await db.query("PRAGMA integrity_check"))[0]
			?.integrity_check;
		return {
			floor: Number(row?.floor),
			identity: (row?.identity as string | null) ?? null,
			pointer: (row?.pointer as string | null) ?? null,
			chunks: Number(chunks),
			integrity: String(integrity),
		};
	} finally {
		await db.close();
	}
}

/**
 * The promote transaction's shape, killed half way: one BEGIN IMMEDIATE that
 * raises the floor, swaps the pointer, then inserts enough chunk rows to spill
 * SQLite's page cache to the OPFS file. The SQL Worker is terminated (a tab
 * crash) while that transaction runs. opfs-sahpool must roll the hot journal
 * back on reopen, so the row is either entirely old or entirely new.
 */
async function killMidTransaction(
	namespace: string,
	killAfterMs: number,
): Promise<KillOutcome> {
	const name = chunkDatabaseName(namespace);
	const before = await snapshot(name);
	let worker: Worker | undefined;
	const db = await openSqlDatabase(
		{ name },
		{
			workerFactory: () => {
				worker = new Worker(new URL("/dist/sql/worker.js", location.href), {
					type: "module",
				});
				return worker;
			},
		},
	);
	const rows = 4_000;
	let settled = false;
	const running = db
		.transaction([
			{
				sql: "UPDATE active_pointer SET floor_sequence = 99, floor_identity = 'torn', pointer = NULL WHERE id = 1",
			},
			{
				sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
				      INSERT INTO chunk(hash, size, body) SELECT printf('%064d', i), 65536, randomblob(65536) FROM n`,
			},
		])
		.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
	await new Promise((resolve) => setTimeout(resolve, killAfterMs));
	const killedMidTransaction = !settled;
	worker?.terminate();
	void running;
	// Let the browser release the dead Worker's Web Lock and OPFS handles.
	await new Promise((resolve) => setTimeout(resolve, 500));
	return {
		before,
		after: await snapshot(name),
		killedMidTransaction,
		rowsAttempted: rows,
	};
}

window.sqliteStore = {
	boot,
	seedLegacy,
	audit,
	tamperRow,
	killMidTransaction,
};
