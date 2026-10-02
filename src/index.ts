// @gainratio/browser — the local-processing substrate of edge-proc, for the tab.
//
// WHAT THIS IS: everything needed to pull a signed, content-addressed bundle
// into a browser and prove it arrived intact — and nothing about what you then
// DO with it. Fetch bytes under a size cap, verify an ed25519 signature over a
// canonical-JSON pointer, bound and verify a zstd decompression, store chunks
// content-addressed in OPFS, reassemble files, and run the whole thing in a
// Worker whose network activity the main thread can actually see.
//
// WHAT THIS IS NOT: a search engine, a recommender, or a sanctions screener.
// Those are products built ON this substrate and they live in their own repos.
// The rule that keeps this package honest: edge-proc is purely a DEPENDENCY of
// its consumers, so nothing consumer-specific may leak in here. If a module
// needs to know what the bundle CONTAINS, it does not belong in this package.
//
// THE INVARIANT EVERY MODULE SERVES: fail closed. An unverifiable byte is not
// a degraded byte, it is a rejected one. Every path that cannot prove integrity
// throws (SignatureError, IntegrityError, RollbackError, SyncCapError, and
// their keyring/expiry subclasses) rather
// than returning something the caller might use.

// --- canonical JSON: the exact bytes a signature is taken over ---
export { canonicalBytes, type JsonValue } from "./engine/canonical.js";
export {
	EngineClient,
	type EngineClientOptions,
	type EngineStorageOptions,
	type EngineSyncOptions,
	type EngineWorkerLike,
} from "./engine/client.js";
// --- ed25519 + sha256: the primitives the whole chain rests on ---
export { SignatureError, sha256Hex, verifyEd25519 } from "./engine/crypto.js";
export {
	classifyEngineError,
	type EngineErrorCode,
	type EngineErrorDetail,
	EngineOperationError,
} from "./engine/engineError.js";
// --- the network edge: size-capped, stall-bounded byte fetch ---
export {
	DEFAULT_MAX_FETCH_BYTES,
	FETCH_STALL_TIMEOUT_MS,
	fetchBytes,
	NetworkError,
	ResponseTooLargeError,
} from "./engine/fetchBytes.js";
export {
	IndexedDbCacheStore,
	type IndexedDbLayout,
	type IndexedDbLayoutOptions,
	resolveIndexedDbLayout,
} from "./engine/indexedDbStore.js";
// --- integrity: bounded decompression + content-address verification ---
export {
	decompressAndVerify,
	IntegrityError,
	MAX_DECOMPRESSED_CHUNK_BYTES,
	verifyPlaintext,
} from "./engine/integrity.js";
// --- the trust root: a raw key or a keyring with rotation + revocation ---
export {
	assertKeyring,
	deriveKeyId,
	KEYRING_SCHEMA,
	KeyRevokedError,
	type Keyring,
	KeyringError,
	loadTrustRoot,
	MAX_TRUST_ROOT_BYTES,
	parseTrustRoot,
	type TrustedKey,
	UnknownKeyError,
	verifyWithKeyring,
} from "./engine/keyring.js";
// --- content-addressed stores: in-memory (tests, ephemeral) and OPFS (real) ---
export { MemoryCacheStore } from "./engine/memoryStore.js";
// --- the network sentinel: makes a Worker's traffic visible to the tab ---
// This is the module that lets a "no backend calls" claim be MEASURED rather
// than asserted. A window-side PerformanceObserver cannot see a Worker's
// fetches; without this, such a counter reads zero exactly when it matters.
export {
	installNetworkSentinel,
	isNetworkSentinelReport,
	NETWORK_SENTINEL_CHANNEL,
	NETWORK_SENTINEL_REPORT_KIND,
	type NetworkSentinelReport,
	type SentinelEntry,
	toSentinelEntries,
} from "./engine/networkSentinel.js";
export {
	canPromotePointer,
	OpfsCacheStore,
	selectHighestPointer,
} from "./engine/opfsStore.js";
export {
	openPersistentCacheStore,
	type PersistentCacheStore,
	type PersistentStoreOptions,
	requestPersistentStorage,
} from "./engine/persistentStore.js";
// --- the Worker boundary: request/response protocol + the main-thread client ---
export type {
	ClearOk,
	ClearRequest,
	EngineErr,
	EngineRequest,
	EngineResponse,
	ReadFileOk,
	ReadFileRequest,
	SyncOk,
	SyncProgressResponse,
	SyncRequest,
} from "./engine/protocol.js";
// --- the sync state machine + file reassembly ---
export {
	type KeyringSyncArgs,
	MAX_CHUNK_RETRY_BUDGET_MS,
	materializeFile,
	PointerExpiredError,
	pointerSigningBytes,
	RollbackError,
	type SyncArgs,
	SyncCapError,
	type SyncProgress,
	syncIndex,
} from "./engine/sync.js";
// --- the wire + seam contracts (single source of truth) ---
export type {
	CacheBackend,
	CacheStore,
	ChunkRef,
	EngineSyncResult,
	FetchBytes,
	FetchBytesOptions,
	FileEntry,
	IndexManifest,
	StoragePreference,
	SyncResult,
	Verify,
	VersionPointer,
} from "./engine/types.js";

// --- typed Worker failures (a Worker that dies during init never replies) ---
export {
	DEFAULT_EMBED_TIMEOUT_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	WorkerCrashError,
	WorkerTimeoutError,
} from "./engine/workerFault.js";
// --- zstd with an explicit expansion bound (a decompression bomb is a bug) ---
export {
	declaredContentSize,
	decompress,
	decompressBounded,
} from "./engine/zstd.js";
