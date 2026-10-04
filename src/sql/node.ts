/// <reference types="node" />
// @gainratio/browser/sql/node — the SQL seam for Node test suites. The SAME
// pinned SQLite build (3.53.4 + FTS5 + JSON1 + sqlite-vector 1.1.2), the same
// client and the same Worker-side handler as the browser, run in-process.
// Every request and response is structured-cloned as postMessage would clone
// it, so a test sees what the browser Worker would. Storage is memory only.

import { readFile } from "node:fs/promises";

import {
	type MemoryProfileSetting,
	resolveMemoryProfile,
} from "../sqlite/memoryProfile.js";
import {
	openSqlDatabase,
	type SqlDatabase,
	type SqlWorkerLike,
} from "./client.js";
import { SqlEngine } from "./engine.js";
import { createSqlWorkerHandler } from "./handler.js";
import { initInProcessSqlite } from "./nodeRuntime.js";
import type { SqlWorkerRequest, SqlWorkerResponse } from "./protocol.js";

export type { SqlDatabase } from "./client.js";

export interface OpenNodeSqlDatabaseOptions {
	/** A label for this database (each call opens a new, empty one). */
	readonly name: string;
	/** SQLite page cache / heap limits. Default "auto". */
	readonly memoryProfile?: MemoryProfileSetting;
}

let wasmBytes: Promise<Uint8Array> | undefined;

/**
 * Open a new in-memory database on the library's pinned SQLite build, in
 * this process. Same {@link SqlDatabase} API as `openSqlDatabase`; OPFS-only
 * calls (legacy pool migration) reject.
 */
export async function openNodeSqlDatabase(
	options: OpenNodeSqlDatabaseOptions,
): Promise<SqlDatabase> {
	// One wasm instance per database, as in the browser (one Worker each):
	// SQLite's heap limits are per instance, so profiles cannot leak across.
	const sqlite = await initInProcessSqlite(await loadWasm());
	const handle = createSqlWorkerHandler(async (opened) => ({
		engine: new SqlEngine(sqlite.openMemory(), {
			storage: { persistence: "memory", reason: "requested" },
			memoryProfile: resolveMemoryProfile(opened.memoryProfile ?? "auto"),
			serializer: sqlite.serializer,
		}),
		release: async () => undefined,
	}));
	return openSqlDatabase(
		{
			name: options.name,
			persistence: "memory",
			...(options.memoryProfile === undefined
				? {}
				: { memoryProfile: options.memoryProfile }),
		},
		{ workerFactory: () => new InProcessSqlWorker(handle) },
	);
}

function loadWasm(): Promise<Uint8Array> {
	wasmBytes ??= readFile(
		new URL("../vector/sqlite/assets/sqlite3.wasm", import.meta.url),
	).then((bytes) => new Uint8Array(bytes));
	return wasmBytes;
}

/** A Worker stand-in: same handler, same structured clone, no thread. */
class InProcessSqlWorker implements SqlWorkerLike {
	readonly #handle: (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>;
	readonly #listeners: Array<(event: MessageEvent<SqlWorkerResponse>) => void> =
		[];
	#terminated = false;

	public constructor(
		handle: (request: SqlWorkerRequest) => Promise<SqlWorkerResponse>,
	) {
		this.#handle = handle;
	}

	public postMessage(request: SqlWorkerRequest): void {
		void this.#handle(structuredClone(request)).then((response) => {
			if (this.#terminated) return;
			const event = { data: structuredClone(response) } as MessageEvent;
			for (const listener of this.#listeners) listener(event);
		});
	}

	public addEventListener(
		type: "message" | "error" | "messageerror",
		listener: (event: never) => void,
	): void {
		if (type === "message") {
			this.#listeners.push(
				listener as (event: MessageEvent<SqlWorkerResponse>) => void,
			);
		}
	}

	public terminate(): void {
		this.#terminated = true;
	}
}
