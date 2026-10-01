// TS mirrors of edge-proc's bundle models (edgeproc/bundles/manifest.py).
// Interface-over-type for object shapes; the JSON wire format is identical
// across the native (Python) and browser tiers — this is the same manifest.

/** One content-defined chunk: `hash` is the bare hex sha256 of its plaintext. */
export interface ChunkRef {
	readonly hash: string;
	/** Uncompressed chunk length in bytes. */
	readonly size: number;
}

/** A file as an ordered list of chunks (order = reassembly order). */
export interface FileEntry {
	readonly path: string;
	readonly file_type: string | null;
	/** Total uncompressed file length. */
	readonly size: number;
	/** Bare hex sha256 of the whole reassembled file. */
	readonly file_sha256: string;
	readonly chunks: ReadonlyArray<ChunkRef>;
}

/** v2 chunked manifest; authenticated by its content hash, not an embedded sig. */
export interface IndexManifest {
	readonly schema_version: number;
	readonly bundle_id: string;
	readonly version: string;
	readonly files: ReadonlyArray<FileEntry>;
	readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** Signed pointer to a manifest; `signature` is detached over the rest. */
export interface VersionPointer {
	/** Hex sha256 of the manifest's canonical bytes. */
	readonly manifest_hash: string;
	readonly version: string;
	/** Optional signed identity binding. Null/absent fields stay out of the
	 * backward-compatible signature preimage. */
	readonly bundle_id?: string | null;
	readonly channel?: string | null;
	/** Required on every incoming release. A cached sequence-less active pointer
	 * may migrate once; after that, lower/missing counters and equal-sequence
	 * different identities are rejected before manifest fetch. */
	readonly sequence: number;
	/** Optional signed signer identity: the first 16 lowercase hex chars of
	 * sha256(raw 32-byte Ed25519 public key). When present, ONLY that keyring
	 * key may verify the pointer; a revoked or unknown id fails closed. Null or
	 * absent stays out of the signature preimage, so older pointers keep their
	 * exact bytes. */
	readonly key_id?: string | null;
	/** Optional signed deadline in Unix seconds (a safe integer > 0). A
	 * network-fetched pointer is refused once `now >= expires_at`; an expired
	 * pointer already cached is still served offline, flagged `expired`. Null
	 * or absent stays out of the signature preimage. */
	readonly expires_at?: number | null;
	/** ed25519 over canonicalBytes(self, exclude {signature}), base64. */
	readonly signature: string;
}

/** Outcome of a `syncIndex` run — proves only-changed-chunks were fetched. */
export interface SyncResult {
	readonly version: string;
	readonly manifestHash: string;
	readonly chunksFetched: number;
	readonly chunksReused: number;
	readonly bytesFetched: number;
	/** Present, and `true`, only when an offline sync served an already-verified
	 * cached bundle whose signed pointer has passed its `expires_at`. The bytes
	 * are intact and authentic, but the publisher no longer vouches that they
	 * are current: surface that to the user. Absent in every other case. */
	readonly expired?: true;
}

export type CacheBackend = "indexeddb" | "opfs+indexeddb";
export type StoragePreference = "auto" | "indexeddb";

/** Sync outcome plus the durable backend selected by the Worker. */
export interface EngineSyncResult extends SyncResult {
	readonly cacheBackend: CacheBackend;
}

/**
 * Local content-addressed store. The OPFS-backed and in-memory implementations
 * share this surface — the seam edge-proc's `cas.py` `CacheStore` Protocol names.
 */
export interface CacheStore {
	hasChunk(chunkHash: string): Promise<boolean>;
	/** Decompress → sha256 → verify == chunkHash (fail-closed) → store. */
	putChunkCompressed(
		chunkHash: string,
		compressed: Uint8Array,
		expectedSize: number,
	): Promise<void>;
	/** Read → decompress → verify == chunkHash (fail-closed) → return plaintext. */
	getChunk(chunkHash: string, expectedSize: number): Promise<Uint8Array>;
	putManifest(manifestBytes: Uint8Array): Promise<string>;
	getManifest(manifestHash: string): Promise<Uint8Array>;
	readActive(): Promise<VersionPointer | null>;
	promote(pointer: VersionPointer): Promise<void>;
	/** Delete the pointer only if it has not raced to a newer authenticated value. */
	clearActiveIf(expected: VersionPointer): Promise<boolean>;
	/** Drop content not reachable from the active release. */
	pruneInactive(): Promise<void>;
	/** Explicitly clear this cache namespace. */
	clear(): Promise<void>;
}

/** Transport seam: fetch raw bytes for a URL (injectable for tests). */
export interface FetchBytesOptions {
	readonly cache?: RequestCache;
	/** Maximum response bytes to buffer. The transport enforces this while
	 * streaming, and sync re-checks injected transports after resolution. */
	readonly maxBytes?: number;
	/** Streaming progress: cumulative bytes received so far and the declared
	 * Content-Length (null when the server sent none). Called on every network
	 * read, so a caller can show real progress and tell "slow" from "stalled". */
	readonly onBytes?: (received: number, total: number | null) => void;
}

export type FetchBytes = (
	url: string,
	options?: FetchBytesOptions,
) => Promise<Uint8Array>;

/** Fail-closed ed25519 verifier: resolves on a valid signature, else throws. */
export type Verify = (
	message: Uint8Array,
	signatureBase64: string,
) => Promise<void>;
