import { IntegrityError } from "./integrity.js";
import type { FetchBytes } from "./types.js";
export declare class NetworkError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
/** A response crossed its caller-owned byte ceiling. Integrity-class, not a
 * recoverable network outage: sync must never silently serve cache for it. */
export declare class ResponseTooLargeError extends IntegrityError {
    constructor(message: string);
}
/**
 * How long a request may go with NO bytes arriving before it is declared
 * stalled and aborted. This is a stall window, not a wall clock: a transfer
 * that keeps delivering bytes is never cut off, however slow the link. Sized
 * for bad mobile links (radio gaps, cell handovers), where a 15 s wall clock
 * turned a 64 KB chunk that legitimately takes 40 s into a retry storm.
 */
export declare const FETCH_STALL_TIMEOUT_MS = 30000;
export declare const DEFAULT_MAX_FETCH_BYTES: number;
export declare const fetchBytes: FetchBytes;
//# sourceMappingURL=fetchBytes.d.ts.map