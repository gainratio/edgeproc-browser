// Typed results for the seal module. Nothing here throws a library error: every
// failure a caller can act on is a `reason`.

/**
 * Why sealing failed. Nothing was written.
 * - `empty_passphrase`, `invalid_work_factor`: the call's arguments.
 * - `out_of_memory`: the device could not allocate scrypt's memory. Retry
 *   later, or with a lower `workFactor`.
 * - `unavailable`: the age library failed to load (a lazily loaded chunk) or
 *   failed in a way it does not document. Retry later.
 */
export type SealRejection =
	| "empty_passphrase"
	| "invalid_work_factor"
	| "out_of_memory"
	| "unavailable";

export type SealResult =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly reason: SealRejection };

/**
 * Why opening failed.
 * - `wrong_passphrase_or_tampered`: authentication failed. The two cannot be
 *   told apart, by design.
 * - `not_sealed`: the bytes are not a format this opener reads.
 * - `malformed`: the format was recognized but its header is damaged.
 * - `unsupported`: a recognized format with a version, recipient, KDF or
 *   cipher this opener will not use (including a legacy iteration count
 *   outside the allowed range).
 * - `too_costly`: the file asks for more scrypt memory than allowed. The age
 *   opener's result carries the file's `workFactor` (scrypt log2 N), so an app
 *   can offer to retry with a higher `maxWorkFactor` (at most 20).
 * - `too_large`: a legacy file larger than its format's size cap.
 * - `out_of_memory`: the device could not allocate scrypt's memory. The
 *   passphrase was NOT judged; retry on a device with more free memory.
 * - `unavailable`: the age library failed to load or failed in a way it does
 *   not document. The passphrase was NOT judged; retry later.
 *
 * A correct passphrase is never reported as `wrong_passphrase_or_tampered`:
 * that reason is returned only for the library's own authentication failures.
 */
export type OpenFailure =
	| "wrong_passphrase_or_tampered"
	| "not_sealed"
	| "malformed"
	| "unsupported"
	| "too_costly"
	| "too_large"
	| "out_of_memory"
	| "unavailable";

export type OpenResult =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| {
			readonly ok: false;
			readonly reason: Exclude<OpenFailure, "too_costly">;
	  }
	| {
			readonly ok: false;
			readonly reason: "too_costly";
			/** The file's scrypt work factor (log2 N) that exceeded the cap. */
			readonly workFactor: number;
	  };
