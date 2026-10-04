export { canonicalBytes, type JsonValue } from "./engine/canonical.js";
export { EngineClient, type EngineClientOptions, type EngineStorageOptions, type EngineSyncOptions, type EngineWorkerLike, } from "./engine/client.js";
export { SignatureError, sha256Hex, verifyEd25519 } from "./engine/crypto.js";
export { classifyEngineError, type EngineErrorCode, type EngineErrorDetail, EngineOperationError, } from "./engine/engineError.js";
export { DEFAULT_MAX_FETCH_BYTES, FETCH_STALL_TIMEOUT_MS, fetchBytes, NetworkError, ResponseTooLargeError, } from "./engine/fetchBytes.js";
export { IndexedDbCacheStore, type IndexedDbLayout, type IndexedDbLayoutOptions, resolveIndexedDbLayout, } from "./engine/indexedDbStore.js";
export { decompressAndVerify, IntegrityError, MAX_DECOMPRESSED_CHUNK_BYTES, verifyPlaintext, } from "./engine/integrity.js";
export { assertKeyring, deriveKeyId, KEYRING_SCHEMA, KeyRevokedError, type Keyring, KeyringError, loadTrustRoot, MAX_TRUST_ROOT_BYTES, parseTrustRoot, type TrustedKey, UnknownKeyError, verifyWithKeyring, } from "./engine/keyring.js";
export { MemoryCacheStore } from "./engine/memoryStore.js";
export { installNetworkSentinel, isNetworkSentinelReport, NETWORK_SENTINEL_CHANNEL, NETWORK_SENTINEL_REPORT_KIND, type NetworkSentinelReport, type SentinelEntry, toSentinelEntries, } from "./engine/networkSentinel.js";
export { canPromotePointer, OpfsCacheStore, selectHighestPointer, } from "./engine/opfsStore.js";
export { openPersistentCacheStore, type PersistentCacheStore, type PersistentStoreOptions, requestPersistentStorage, } from "./engine/persistentStore.js";
export type { ClearOk, ClearRequest, EngineErr, EngineRequest, EngineResponse, ReadFileOk, ReadFileRequest, SyncOk, SyncProgressResponse, SyncRequest, } from "./engine/protocol.js";
export { type KeyringSyncArgs, MAX_CHUNK_RETRY_BUDGET_MS, materializeFile, PointerExpiredError, pointerSigningBytes, RollbackError, type SyncArgs, SyncCapError, type SyncProgress, syncIndex, } from "./engine/sync.js";
export type { CacheBackend, CacheStore, ChunkRef, CompressedChunk, EngineSyncResult, FetchBytes, FetchBytesOptions, FileEntry, IndexManifest, StoragePreference, SyncResult, Verify, VersionPointer, } from "./engine/types.js";
export { DEFAULT_EMBED_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, WorkerCrashError, WorkerTimeoutError, } from "./engine/workerFault.js";
export { declaredContentSize, decompress, decompressBounded, } from "./engine/zstd.js";
//# sourceMappingURL=index.d.ts.map