import { type SqlFallbackReason } from "../sql/types.js";
export type EngineErrorCode = "integrity" | "rollback" | "network" | "lock" | "storage" | "internal";
/** Why the engine's persistent cache could not be opened. */
export type EngineStorageUnavailableReason = SqlFallbackReason;
export interface EngineErrorDetail {
    readonly code: EngineErrorCode;
    readonly message: string;
    /** Set (with code "storage") when the persistent cache could not open. */
    readonly reason?: EngineStorageUnavailableReason;
}
/** A stable main-thread error that preserves the Worker's failure category. */
export declare class EngineOperationError extends Error {
    readonly code: EngineErrorCode;
    constructor(detail: EngineErrorDetail);
}
/**
 * The persistent OPFS cache could not be opened and no in-memory fallback was
 * allowed (`cacheFallback: "none"`), or using one would be unsafe. Nothing was
 * downloaded. Still an {@link EngineOperationError} with code "storage".
 */
export declare class EngineStorageUnavailableError extends EngineOperationError {
    readonly reason: EngineStorageUnavailableReason;
    constructor(detail: EngineErrorDetail & {
        readonly reason: EngineStorageUnavailableReason;
    });
}
/** The main-thread error for a Worker failure detail. */
export declare function engineErrorOf(detail: EngineErrorDetail): EngineOperationError;
export declare function classifyEngineError(error: unknown): EngineErrorDetail;
//# sourceMappingURL=engineError.d.ts.map