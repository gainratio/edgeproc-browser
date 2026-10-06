import type { OpenFailure } from "./types.js";
export declare const LEGACY_MIN_ITERATIONS = 100000;
export declare const LEGACY_MAX_ITERATIONS = 10000000;
export type LegacyFormat = "almamesh-portable-v3" | "almamesh-backup-v2" | "almamesh-backup-v1" | "amlfilter-install-key-v1";
export type LegacyOpenResult = {
    readonly ok: true;
    /** The decrypted payload, exactly as the app encrypted it. */
    readonly bytes: Uint8Array;
    readonly format: LegacyFormat;
} | {
    readonly ok: false;
    readonly reason: OpenFailure;
};
/**
 * Open a file written by an older app version (almamesh portable v3, almamesh
 * backup v1/v2, aml-filter install-key v1). Read-only: never use these formats
 * to write. JSON formats may be passed as bytes or text. Never throws on bad
 * input; the payload comes back exactly as the app encrypted it, and the app
 * applies its own checks (for example aml-filter's public-key match).
 */
export declare function openLegacyPbkdf2AesGcm(file: Uint8Array | string, passphrase: string): Promise<LegacyOpenResult>;
//# sourceMappingURL=legacy.d.ts.map