/// <reference types="node" />
// Test-only: load the SAME pinned sqlite3.wasm the Worker ships, in Node, so
// the engine's SQL behaviour is proven against the real build, not a fake.

import { readFile } from "node:fs/promises";

import { type InProcessSqlite, initInProcessSqlite } from "../nodeRuntime";

export type NodeSqlite = InProcessSqlite;

export async function loadNodeSqlite(): Promise<NodeSqlite> {
	return initInProcessSqlite(
		new Uint8Array(
			await readFile(
				new URL("../../vector/sqlite/assets/sqlite3.wasm", import.meta.url),
			),
		),
	);
}
