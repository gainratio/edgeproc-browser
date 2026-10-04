/// <reference types="node" />
// Test-only: load the SAME pinned sqlite3.wasm the Worker ships, in Node, so
// the engine's SQL behaviour is proven against the real build, not a fake.

import { readFile } from "node:fs/promises";

import sqlite3InitModule from "../../vector/sqlite/assets/sqlite3.mjs";
import type { SqlRawDatabase } from "../engine.js";
import { createSqlSerializer, type SqlSerializer } from "../serializer.js";

export interface NodeSqlite {
	openMemory(): SqlRawDatabase;
	readonly serializer: SqlSerializer;
}

let queue: Promise<unknown> = Promise.resolve();

export function loadNodeSqlite(): Promise<NodeSqlite> {
	const load = async (): Promise<NodeSqlite> => {
		const wasm = new Uint8Array(
			await readFile(
				new URL("../../vector/sqlite/assets/sqlite3.wasm", import.meta.url),
			),
		);
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
