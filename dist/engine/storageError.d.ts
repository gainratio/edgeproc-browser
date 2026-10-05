import { type SqlFallbackReason } from "../sql/types.js";
/** A stable storage-boundary failure suitable for Worker error classification. */
export declare class StorageQuotaError extends Error {
    constructor(message?: string, options?: ErrorOptions);
}
export declare function isQuotaError(error: unknown): boolean;
export declare function translateStorageError(error: unknown): Error;
/** The engine's OPFS cache could not be opened and the consumer chose
 * `cacheFallback: "none"`: nothing was opened in memory, nothing fetched. */
export declare class CacheFallbackRefusedError extends Error {
    readonly reason: SqlFallbackReason;
    constructor(reason: SqlFallbackReason, message: string, options?: ErrorOptions);
}
/** Open with `fallback: "none"`: an OPFS refusal becomes the typed
 * {@link CacheFallbackRefusedError}; every other failure passes through. */
export declare function refuseWithoutFallback<T>(open: () => Promise<T>): Promise<T>;
//# sourceMappingURL=storageError.d.ts.map