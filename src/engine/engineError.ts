import type { SqlFallbackReason } from "../sql/types.js";
import { SignatureError } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError } from "./integrity.js";
import {
	CacheFallbackRefusedError,
	StorageQuotaError,
} from "./storageError.js";
import { RollbackError } from "./sync.js";

export type EngineErrorCode =
	| "integrity"
	| "rollback"
	| "network"
	| "lock"
	| "storage"
	| "internal";

/** Why the engine's persistent cache could not be opened. */
export type EngineStorageUnavailableReason = SqlFallbackReason;

export interface EngineErrorDetail {
	readonly code: EngineErrorCode;
	readonly message: string;
	/** Set (with code "storage") when the persistent cache could not open. */
	readonly reason?: EngineStorageUnavailableReason;
}

/** A stable main-thread error that preserves the Worker's failure category. */
export class EngineOperationError extends Error {
	public readonly code: EngineErrorCode;

	public constructor(detail: EngineErrorDetail) {
		super(detail.message);
		this.name = "EngineOperationError";
		this.code = detail.code;
	}
}

/**
 * The persistent OPFS cache could not be opened and the consumer chose
 * `cacheFallback: "none"`, so no in-memory cache was opened and nothing was
 * downloaded. An {@link EngineOperationError} with code "storage".
 */
export class EngineStorageUnavailableError extends EngineOperationError {
	public readonly reason: EngineStorageUnavailableReason;

	public constructor(
		detail: EngineErrorDetail & {
			readonly reason: EngineStorageUnavailableReason;
		},
	) {
		super(detail);
		this.name = "EngineStorageUnavailableError";
		this.reason = detail.reason;
	}
}

/** The main-thread error for a Worker failure detail. */
export function engineErrorOf(detail: EngineErrorDetail): EngineOperationError {
	return detail.code === "storage" && detail.reason !== undefined
		? new EngineStorageUnavailableError({ ...detail, reason: detail.reason })
		: new EngineOperationError(detail);
}

export function classifyEngineError(error: unknown): EngineErrorDetail {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof RollbackError) return { code: "rollback", message };
	if (error instanceof SignatureError || error instanceof IntegrityError) {
		return { code: "integrity", message };
	}
	if (error instanceof NetworkError) return { code: "network", message };
	if (error instanceof CacheFallbackRefusedError) {
		return { code: "storage", message, reason: error.reason };
	}
	if (/timed out acquiring (?:an? )?opfs mutation lock/iu.test(message)) {
		return { code: "lock", message };
	}
	if (
		error instanceof StorageQuotaError ||
		/storage|indexeddb|opfs|quota/iu.test(message)
	) {
		return { code: "storage", message };
	}
	return { code: "internal", message };
}
