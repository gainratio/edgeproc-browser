/// <reference lib="webworker" />

// Chromium-only probe of how sqlite3.mjs installs its OPFS VFSes. The page
// hands over a prelude (and optionally a replacement body) for the async
// proxy script; the Worker spawns the proxy from a Blob built from them, runs
// the loader once, and reports which VFSes exist and what the loader warned.

import { OPFS_ASYNC_PROXY_SOURCE } from "../../src/vector/sqlite/assets/opfsAsyncProxySource.js";
import sqlite3InitModule from "../../src/vector/sqlite/assets/sqlite3.mjs";

export interface OpfsInstallProbe {
	/** JavaScript prepended to the proxy script (runs in the proxy Worker). */
	readonly prelude: string;
	/** Replaces the real proxy script when set; a probe of the load guard. */
	readonly body?: string;
}

export interface OpfsInstallResult {
	readonly opfs: boolean;
	readonly opfsWl: boolean;
	readonly warnings: ReadonlyArray<string>;
	readonly elapsedMs: number;
}

self.onmessage = async (event: MessageEvent<OpfsInstallProbe>) => {
	const probe = event.data;
	const warnings: string[] = [];
	const source = [probe.prelude, probe.body ?? OPFS_ASYNC_PROXY_SOURCE];
	(globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
		opfsProxyUri: URL.createObjectURL(
			new Blob(source, { type: "text/javascript" }),
		),
		warn: (...args: unknown[]) => {
			warnings.push(args.map((arg) => String(arg)).join(" "));
		},
	};
	const started = performance.now();
	const sqlite3 = await sqlite3InitModule({
		print: () => undefined,
		printErr: () => undefined,
	});
	const oo1 = sqlite3.oo1 as { OpfsDb?: unknown; OpfsWlDb?: unknown };
	const result: OpfsInstallResult = {
		opfs: oo1.OpfsDb !== undefined,
		opfsWl: oo1.OpfsWlDb !== undefined,
		warnings,
		elapsedMs: Math.round(performance.now() - started),
	};
	self.postMessage(result);
};
