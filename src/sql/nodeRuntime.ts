// The pinned sqlite-wasm module, initialised for an in-process (Node) host.
// Free of node: imports — the caller hands over the wasm bytes — so the only
// Node-only module in dist/sql stays node.js.

import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs";
import type { SqlRawDatabase } from "./engine.js";
import { createSqlSerializer, type SqlSerializer } from "./serializer.js";

type SqliteModule = Awaited<ReturnType<typeof sqlite3InitModule>>;

export interface InProcessSqlite {
	readonly module: SqliteModule;
	readonly serializer: SqlSerializer;
	openMemory(): SqlRawDatabase;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Initialise the pinned build from `wasm`. sqlite3.mjs auto-installs its OPFS
 * VFSes when it sees a `location`; the shim below tells it not to (there is no
 * OPFS here) and is removed again, one initialisation at a time.
 */
export function initInProcessSqlite(
	wasm: Uint8Array,
): Promise<InProcessSqlite> {
	const load = async (): Promise<InProcessSqlite> => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "location");
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { href: "https://edgeproc.invalid/?opfs-disable&opfs-wl-disable" },
		});
		try {
			const sqlite = await sqlite3InitModule({
				wasmBinary: wasm,
				print: () => undefined,
				printErr: () => undefined,
			});
			return {
				module: sqlite,
				serializer: createSqlSerializer(sqlite),
				openMemory: () =>
					new sqlite.oo1.DB(":memory:") as unknown as SqlRawDatabase,
			};
		} finally {
			if (original === undefined) {
				delete (globalThis as { location?: unknown }).location;
			} else {
				Object.defineProperty(globalThis, "location", original);
			}
		}
	};
	const next = queue.then(load, load);
	queue = next.catch(() => undefined);
	return next;
}
