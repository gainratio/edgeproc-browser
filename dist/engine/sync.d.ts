import { IntegrityError } from "./integrity.js";
import { type Keyring } from "./keyring.js";
import type { CacheStore, FetchBytes, IndexManifest, SyncResult, Verify, VersionPointer } from "./types.js";
export type SyncProgress = {
    readonly phase: "pointer";
    readonly version: string;
} | {
    readonly phase: "manifest";
    readonly totalFiles: number;
    readonly selectedFiles: number;
} | {
    /** Reported on every network read (rate-limited) and on every
     * verified chunk, so a consumer can draw a real progress bar and an
     * idle timer can tell "slow" from "stalled". */
    readonly phase: "chunks";
    /** Chunks fetched, verified and stored so far. */
    readonly fetchedChunks: number;
    /** Chunks this sync has to fetch (missing from the cache). */
    readonly totalChunks: number;
    /** Compressed (on-the-wire) bytes of the completed chunks. */
    readonly bytesFetched: number;
    /** Uncompressed bytes of every chunk this sync fetches: exact, from
     * the signed manifest, known before the first byte arrives. */
    readonly bytesTotal: number;
    /** Uncompressed-byte progress: completed chunks plus the received
     * fraction of in-flight ones. Reaches `bytesTotal` exactly. */
    readonly bytesDone: number;
} | {
    /** One chunk fetch failed as a network outage or stall and is being
     * retried after `delayMs`. Bytes already verified are kept. */
    readonly phase: "chunkRetry";
    readonly hash: string;
    /** Attempts made so far (1 = the first attempt just failed). */
    readonly attempt: number;
    readonly maxAttempts: number;
    readonly delayMs: number;
    readonly reason: string;
} | {
    /** Every chunk is in; files are being reassembled and checked
     * against their signed hashes. */
    readonly phase: "verify";
    readonly verifiedFiles: number;
    readonly totalFiles: number;
} | {
    readonly phase: "promoted";
    readonly result: SyncResult;
};
export interface SyncArgs {
    readonly baseUrl: string;
    readonly store: CacheStore;
    readonly fetchBytes: FetchBytes;
    /** Single-verifier seam: authoritative for every signature. A pointer's
     * `key_id` is covered by the signature but cannot select a key here; use
     * {@link KeyringSyncArgs} for key selection and revocation. */
    readonly verify: Verify;
    /** Mutually exclusive with `verify`; see {@link KeyringSyncArgs}. */
    readonly keyring?: never;
    /** Clock for `expires_at`, in Unix SECONDS (fractions allowed). Defaults to
     * `Date.now() / 1000`. Read only for pointers that carry `expires_at`; a
     * non-finite reading fails closed with a TypeError. */
    readonly now?: () => number;
    /** undefined skips the check; null requires a legacy absent/null identity. */
    readonly expectedBundleId?: string | null;
    /** undefined skips the check; null requires a legacy absent/null channel. */
    readonly expectedChannel?: string | null;
    /** undefined fetches all file chunks; [] authenticates/promotes the catalog only. */
    readonly wantedPaths?: ReadonlyArray<string>;
    /** Observer only: exceptions are isolated from the integrity state machine. */
    readonly onProgress?: (progress: SyncProgress) => void;
    /** Test seam for bounded per-chunk network retry backoff. */
    readonly sleep?: (milliseconds: number) => Promise<void>;
    /** Tests/operators may only LOWER the aggregate cap, never raise the release
     * ceiling. This keeps failure paths cheap to exercise without weakening prod. */
    readonly limits?: {
        readonly maxTotalFetchBytes?: number;
    };
}
/** Maximum silent backoff before one chunk fetch is declared unreachable. */
export declare const MAX_CHUNK_RETRY_BUDGET_MS: number;
/** Sync verified under a trust-root keyring instead of a single verifier:
 * `key_id` selects the key, revoked keys never verify, and an unknown key
 * fails closed. Exactly one of `verify` / `keyring` must be supplied. */
export interface KeyringSyncArgs extends Omit<SyncArgs, "verify" | "keyring"> {
    readonly keyring: Keyring;
    readonly verify?: never;
}
export declare class SyncCapError extends IntegrityError {
    constructor(message: string);
}
export declare class RollbackError extends IntegrityError {
    constructor(message: string);
}
/** A validly signed network pointer is at or past its signed `expires_at`:
 * the publisher no longer vouches that it is current (a freeze/replay). */
export declare class PointerExpiredError extends IntegrityError {
    constructor(message?: string);
}
/** The exact bytes a pointer's signature covers: canonical JSON without
 * `signature`, and without any optional field that is null or absent — so a
 * pointer that predates an optional field keeps its original preimage. */
export declare function pointerSigningBytes(pointer: VersionPointer): Uint8Array;
/** Ceiling on concurrent cached-chunk reads and presence probes. A warm boot
 * is dominated by per-chunk storage round trips (an OPFS file handle per
 * chunk), not by hashing; awaiting them one at a time serialised that latency. */
export declare const MAX_CONCURRENT_CHUNK_READS = 8;
/**
 * Sync the signed bundle at `baseUrl` into `store`, verified by exactly one
 * of `verify` (a single verifier) or `keyring` (key selection + revocation).
 * A network pointer at or past its signed `expires_at` is refused with
 * {@link PointerExpiredError}; an offline sync may still serve an expired
 * cached bundle, flagged `expired: true`.
 */
export declare function syncIndex(args: SyncArgs | KeyringSyncArgs): Promise<SyncResult>;
export declare function materializeFile(store: CacheStore, manifest: IndexManifest, path: string): Promise<Uint8Array>;
//# sourceMappingURL=sync.d.ts.map