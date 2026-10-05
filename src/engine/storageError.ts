import {
	type SqlFallbackReason,
	SqlStorageUnavailableError,
} from "../sql/types.js";

/** A stable storage-boundary failure suitable for Worker error classification. */
export class StorageQuotaError extends Error {
	public constructor(
		message = "browser storage quota exhausted",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "StorageQuotaError";
	}
}

export function isQuotaError(error: unknown): boolean {
	return (
		(error instanceof DOMException &&
			["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"].includes(
				error.name,
			)) ||
		(error instanceof Error &&
			(error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
				/quota(?:[ _-]?exceeded|[ _-]?reached)?/iu.test(error.message)))
	);
}

export function translateStorageError(error: unknown): Error {
	return isQuotaError(error)
		? new StorageQuotaError("browser storage quota exhausted", { cause: error })
		: error instanceof Error
			? error
			: new Error(String(error));
}

/** The engine's OPFS cache could not be opened and the consumer chose
 * `cacheFallback: "none"`: nothing was opened in memory, nothing fetched. */
export class CacheFallbackRefusedError extends Error {
	public readonly reason: SqlFallbackReason;

	public constructor(
		reason: SqlFallbackReason,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "CacheFallbackRefusedError";
		this.reason = reason;
	}
}

/** Open with `fallback: "none"`: an OPFS refusal becomes the typed
 * {@link CacheFallbackRefusedError}; every other failure passes through. */
export async function refuseWithoutFallback<T>(
	open: () => Promise<T>,
): Promise<T> {
	try {
		return await open();
	} catch (error) {
		if (error instanceof SqlStorageUnavailableError) {
			throw new CacheFallbackRefusedError(error.reason, error.message, {
				cause: error,
			});
		}
		throw error;
	}
}
