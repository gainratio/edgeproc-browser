// Typed postMessage envelopes between the main thread and the Worker. The Worker
// owns the SQLite chunk database + the sync engine; the main thread only sends requests + awaits
// replies. Discriminated unions on `kind` / `ok` keep the bridge type-safe.

import type { EngineErrorDetail } from "./engineError.js";
import type { IndexedDbLayoutOptions } from "./legacyStores.js";
import type { SyncProgress } from "./sync.js";
import type { EngineSyncResult } from "./types.js";

/** Sync the signed bundle at `baseUrl`, pinning the trust root at `pubkeyUrl`:
 * a raw 32-byte Ed25519 key, or an `edgeproc.keyring/v1` JSON keyring. */
export interface SyncRequest {
	readonly kind: "sync";
	readonly id: number;
	readonly baseUrl: string;
	readonly pubkeyUrl: string;
	readonly expectedBundleId?: string | null;
	readonly expectedChannel?: string | null;
	readonly wantedPaths?: ReadonlyArray<string>;
	readonly cacheNamespace?: string;
	readonly indexedDbLayout?: IndexedDbLayoutOptions;
}

/** Materialize a synced file's bytes from the active manifest. */
export interface ReadFileRequest {
	readonly kind: "readFile";
	readonly id: number;
	readonly path: string;
}

/** Clear the configured durable cache under the same cross-tab lock as sync/read. */
export interface ClearRequest {
	readonly kind: "clear";
	readonly id: number;
	readonly cacheNamespace?: string;
	readonly indexedDbLayout?: IndexedDbLayoutOptions;
}

export type EngineRequest = SyncRequest | ReadFileRequest | ClearRequest;

export interface SyncOk {
	readonly ok: true;
	readonly id: number;
	readonly kind: "sync";
	readonly result: EngineSyncResult;
}

export interface SyncProgressResponse {
	readonly ok: true;
	readonly id: number;
	readonly kind: "syncProgress";
	readonly progress: SyncProgress;
}

export interface ReadFileOk {
	readonly ok: true;
	readonly id: number;
	readonly kind: "readFile";
	readonly bytes: Uint8Array;
}

export interface ClearOk {
	readonly ok: true;
	readonly id: number;
	readonly kind: "clear";
}

export interface EngineErr {
	readonly ok: false;
	readonly id: number;
	readonly kind: EngineRequest["kind"];
	readonly error: EngineErrorDetail;
}

export type EngineResponse =
	| SyncOk
	| SyncProgressResponse
	| ReadFileOk
	| ClearOk
	| EngineErr;
