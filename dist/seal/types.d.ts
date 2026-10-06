/** Why sealing was refused. Nothing was written. */
export type SealRejection = "empty_passphrase" | "invalid_work_factor";
export type SealResult = {
    readonly ok: true;
    readonly bytes: Uint8Array;
} | {
    readonly ok: false;
    readonly reason: SealRejection;
};
/**
 * Why opening failed.
 * - `wrong_passphrase_or_tampered`: authentication failed. The two cannot be
 *   told apart, by design.
 * - `not_sealed`: the bytes are not a format this opener reads.
 * - `malformed`: the format was recognized but its header is damaged.
 * - `unsupported`: a recognized format with a version, recipient, KDF or
 *   cipher this opener will not use (including a legacy iteration count
 *   outside the allowed range).
 * - `too_costly`: the file asks for more scrypt memory than allowed.
 * - `too_large`: a legacy file larger than its format's size cap.
 */
export type OpenFailure = "wrong_passphrase_or_tampered" | "not_sealed" | "malformed" | "unsupported" | "too_costly" | "too_large";
export type OpenResult = {
    readonly ok: true;
    readonly bytes: Uint8Array;
} | {
    readonly ok: false;
    readonly reason: OpenFailure;
};
//# sourceMappingURL=types.d.ts.map