// The two 0.2.x stores, as one-time migration sources. Nothing here writes:
// it reads a store whole, and after SQLite has committed the copy it deletes
// the entries this library created. It is the ONLY module allowed to touch
// IndexedDB (storageGuard.test.ts enforces that), and it opens a database
// without ever creating one: a missing database aborts its own upgrade.
//
//   OPFS (origin root): chunk/<hash>, manifest/<hash>, active, active.a,
//     active.b, mutation.lock
//   IndexedDB: `${database}` / `${store}`, keys `chunk${sep}<hash>`,
//     `manifest${sep}<hash>` and `active` (the rollback floor)

import { parseStoredPointer } from "./activePointer.js";
import { cacheDatabaseName } from "./cacheLock.js";
import type { LegacySnapshot, LegacySource } from "./migration.js";
import type { VersionPointer } from "./types.js";

export interface IndexedDbLayout {
	readonly database: string;
	readonly store: string;
	readonly separator: ":" | "/";
}

export type IndexedDbLayoutOptions = Partial<IndexedDbLayout>;

const DEFAULT_STORE = "content-addressed-cache";
const ACTIVE = "active";
const OPFS_POINTERS = ["active", "active.a", "active.b"] as const;
const OPFS_ENTRIES = ["chunk", "manifest", ...OPFS_POINTERS, "mutation.lock"];
const MAX_POINTER_BYTES = 16 * 1024;
const MAX_LEGACY_OBJECT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const DECODER = new TextDecoder();
const EMPTY: LegacySnapshot = { chunks: [], manifests: [], pointers: [] };

export function resolveIndexedDbLayout(
	options: IndexedDbLayoutOptions = {},
	defaultDatabase = cacheDatabaseName(),
): IndexedDbLayout {
	const database = validatedName(
		options.database ?? defaultDatabase,
		"database",
	);
	const store = validatedName(options.store ?? DEFAULT_STORE, "object store");
	const separator = options.separator ?? ":";
	if (separator !== ":" && separator !== "/") {
		throw new TypeError("IndexedDB key separator must be ':' or '/'");
	}
	return { database, store, separator };
}

export function indexedDbLegacySource(
	layout: IndexedDbLayout,
	factory: IDBFactory = indexedDB,
): LegacySource {
	return {
		label: `indexeddb:${layout.database}/${layout.store}`,
		readPointers: async () => {
			const db = await openExisting(factory, layout);
			if (db === null) return [];
			try {
				const store = db
					.transaction(layout.store, "readonly")
					.objectStore(layout.store);
				const value = await settle(store.get(ACTIVE));
				return value === undefined ? [] : [pointerFromValue(value)];
			} finally {
				db.close();
			}
		},
		read: async () => {
			const db = await openExisting(factory, layout);
			if (db === null) return EMPTY;
			try {
				return await readIndexedDb(db, layout);
			} finally {
				db.close();
			}
		},
		remove: async () => {
			const db = await openExisting(factory, layout);
			if (db === null) return;
			try {
				await deleteOwnKeys(db, layout);
			} finally {
				db.close();
			}
		},
	};
}

/** Open `layout.database` only if it already exists and has `layout.store`. */
function openExisting(
	factory: IDBFactory,
	layout: IndexedDbLayout,
): Promise<IDBDatabase | null> {
	return new Promise((resolve, reject) => {
		const request = factory.open(layout.database);
		let created = false;
		request.onupgradeneeded = () => {
			created = true;
			request.transaction?.abort();
		};
		request.onsuccess = () => {
			const db = request.result;
			if (db.objectStoreNames.contains(layout.store)) resolve(db);
			else {
				db.close();
				resolve(null);
			}
		};
		request.onerror = () => {
			if (created) {
				request.onerror = null;
				resolve(null);
			} else reject(request.error);
		};
	});
}

async function readIndexedDb(
	db: IDBDatabase,
	layout: IndexedDbLayout,
): Promise<LegacySnapshot> {
	const store = db
		.transaction(layout.store, "readonly")
		.objectStore(layout.store);
	const [keys, values] = await Promise.all([
		settle(store.getAllKeys()),
		settle(store.getAll()),
	]);
	const chunks: Array<{ hash: string; body: Uint8Array }> = [];
	const manifests: Array<{ hash: string; body: Uint8Array }> = [];
	const pointers: Array<VersionPointer | null> = [];
	keys.forEach((key, index) => {
		const value = values[index];
		if (key === ACTIVE) {
			pointers.push(pointerFromValue(value));
			return;
		}
		const parsed = ownKey(key, layout.separator);
		const body = bytesOf(value, MAX_LEGACY_OBJECT_BYTES);
		if (parsed === null || body === null) return;
		(parsed.kind === "chunk" ? chunks : manifests).push({
			hash: parsed.hash,
			body,
		});
	});
	return { chunks, manifests, pointers };
}

async function deleteOwnKeys(
	db: IDBDatabase,
	layout: IndexedDbLayout,
): Promise<void> {
	const tx = db.transaction(layout.store, "readwrite");
	const store = tx.objectStore(layout.store);
	const keys = await settle(store.getAllKeys());
	for (const key of keys) {
		if (key === ACTIVE || ownKey(key, layout.separator) !== null) {
			store.delete(key);
		}
	}
	await transactionDone(tx);
}

/** @internal Resolves on commit; an error or abort (an error always aborts)
 * rejects, so a delete that did not land is never reported as done. */
export function transactionDone(
	tx: Pick<IDBTransaction, "oncomplete" | "onabort" | "error">,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onabort = () => reject(tx.error ?? new Error("legacy delete aborted"));
	});
}

function ownKey(
	key: IDBValidKey,
	separator: IndexedDbLayout["separator"],
): { readonly kind: "chunk" | "manifest"; readonly hash: string } | null {
	if (typeof key !== "string") return null;
	for (const kind of ["chunk", "manifest"] as const) {
		const prefix = `${kind}${separator}`;
		if (key.startsWith(prefix) && SHA256.test(key.slice(prefix.length))) {
			return { kind, hash: key.slice(prefix.length) };
		}
	}
	return null;
}

function pointerFromValue(value: unknown): VersionPointer | null {
	const bytes = bytesOf(value, MAX_POINTER_BYTES);
	try {
		return parseStoredPointer(
			bytes === null ? value : (JSON.parse(DECODER.decode(bytes)) as unknown),
		);
	} catch {
		return null;
	}
}

function bytesOf(value: unknown, cap: number): Uint8Array | null {
	if (ArrayBuffer.isView(value) && value.byteLength <= cap) {
		return new Uint8Array(
			value.buffer,
			value.byteOffset,
			value.byteLength,
		).slice();
	}
	if (
		Object.prototype.toString.call(value) === "[object ArrayBuffer]" &&
		(value as ArrayBuffer).byteLength <= cap
	) {
		return new Uint8Array(value as ArrayBuffer).slice();
	}
	return null;
}

/** @internal */
export function settle<T>(
	request: Pick<IDBRequest<T>, "onsuccess" | "onerror" | "result" | "error">,
): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** The slice of an OPFS directory handle the legacy reader needs. */
export interface LegacyDirectory {
	getDirectoryHandle(name: string): Promise<LegacyDirectory>;
	getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
	keys(): AsyncIterableIterator<string>;
	removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

export function opfsLegacySource(
	openRoot: () => Promise<LegacyDirectory> = defaultOpfsRoot,
): LegacySource {
	// A browser that refuses the OPFS root (Safari private mode, Playwright's
	// WebKit) refused it to 0.2.x too: there is no OPFS store to read or floor
	// to honour. Any OTHER failure inside a readable root still propagates.
	const root = async (): Promise<LegacyDirectory | null> => {
		try {
			return await openRoot();
		} catch {
			return null;
		}
	};
	return {
		label: "opfs:origin-root",
		readPointers: async () => {
			const dir = await root();
			if (dir === null) return [];
			return Promise.all(
				OPFS_POINTERS.map((name) => readPointerFile(dir, name)),
			);
		},
		read: async () => {
			const dir = await root();
			if (dir === null) return EMPTY;
			const [chunks, manifests, pointers] = await Promise.all([
				readObjects(dir, "chunk"),
				readObjects(dir, "manifest"),
				Promise.all(OPFS_POINTERS.map((name) => readPointerFile(dir, name))),
			]);
			return { chunks, manifests, pointers };
		},
		remove: async () => {
			const dir = await root();
			if (dir === null) return;
			for (const name of OPFS_ENTRIES) {
				await removeIfPresent(dir, name);
			}
		},
	};
}

function defaultOpfsRoot(): Promise<LegacyDirectory> {
	return navigator.storage.getDirectory() as unknown as Promise<LegacyDirectory>;
}

async function readObjects(
	root: LegacyDirectory,
	name: string,
): Promise<Array<{ hash: string; body: Uint8Array }>> {
	const dir = await childDirectory(root, name);
	if (dir === null) return [];
	const out: Array<{ hash: string; body: Uint8Array }> = [];
	for await (const hash of dir.keys()) {
		if (!SHA256.test(hash)) continue;
		const body = await readFile(dir, hash, MAX_LEGACY_OBJECT_BYTES);
		if (body !== null) out.push({ hash, body });
	}
	return out;
}

async function readPointerFile(
	root: LegacyDirectory,
	name: string,
): Promise<VersionPointer | null> {
	const bytes = await readFile(root, name, MAX_POINTER_BYTES);
	if (bytes === null) return null;
	try {
		return parseStoredPointer(JSON.parse(DECODER.decode(bytes)) as unknown);
	} catch {
		return null;
	}
}

async function readFile(
	dir: LegacyDirectory,
	name: string,
	cap: number,
): Promise<Uint8Array | null> {
	try {
		const file = await (await dir.getFileHandle(name)).getFile();
		if (file.size > cap) return null;
		return new Uint8Array(await file.arrayBuffer());
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

async function childDirectory(
	root: LegacyDirectory,
	name: string,
): Promise<LegacyDirectory | null> {
	try {
		return await root.getDirectoryHandle(name);
	} catch (error) {
		if (isNotFound(error) || isTypeMismatch(error)) return null;
		throw error;
	}
}

async function removeIfPresent(
	dir: LegacyDirectory,
	name: string,
): Promise<void> {
	try {
		await dir.removeEntry(name, { recursive: true });
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return (
		(error as { readonly name?: unknown } | null)?.name === "NotFoundError"
	);
}

function isTypeMismatch(error: unknown): boolean {
	return (
		(error as { readonly name?: unknown } | null)?.name === "TypeMismatchError"
	);
}

function validatedName(value: string, label: string): string {
	if (!/^[a-z][a-z0-9-]{0,127}$/u.test(value)) {
		throw new TypeError(
			`IndexedDB ${label} must start with a letter and contain only lowercase letters, digits, or hyphens`,
		);
	}
	return value;
}
