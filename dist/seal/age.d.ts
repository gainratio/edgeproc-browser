import type { OpenResult, SealResult } from "./types.js";
/**
 * scrypt work factor (log2 N, r=8, p=1) for new files: 17 = 128 MiB, the
 * OWASP Password Storage floor for scrypt. age's CLI default is 18 (256 MiB);
 * we stay one step lower because low-memory phones (the iPhone OOM history in
 * our apps) are the devices that must not crash.
 */
export declare const DEFAULT_SCRYPT_WORK_FACTOR = 17;
/** Allowed range for `workFactor` when sealing. Below 16 is for tests only. */
export declare const MIN_SCRYPT_WORK_FACTOR = 10;
export declare const MAX_SCRYPT_WORK_FACTOR = 20;
/**
 * Highest work factor `openWithPassphrase` will compute by default: 18
 * (256 MiB) opens files made by the age CLI's default; a hostile file cannot
 * make us allocate more. Raise it per call with `maxWorkFactor`; values above
 * 20 (age's own ceiling) are clamped to 20.
 */
export declare const DEFAULT_MAX_OPEN_WORK_FACTOR = 18;
export interface SealOptions {
    /** scrypt log2 N, an integer in 10..20. Defaults to 17. */
    readonly workFactor?: number;
}
export interface OpenOptions {
    /**
     * Refuse files whose scrypt log2 N is above this. Defaults to 18; clamped
     * to 20. NaN means the default.
     */
    readonly maxWorkFactor?: number;
}
/** True for a binary or ASCII-armored age v1 file. Does not authenticate. */
export declare function isSealed(bytes: Uint8Array): boolean;
/**
 * Seal bytes under a passphrase as a standard age v1 file (scrypt recipient).
 * The passphrase is sealed in NFC form. It is not length-checked here: gate
 * new passphrases with `checkNewPassphrase` first.
 */
export declare function sealWithPassphrase(plaintext: Uint8Array, passphrase: string, options?: SealOptions): Promise<SealResult>;
/** Open an age v1 passphrase file. Never throws on bad input. */
export declare function openWithPassphrase(sealed: Uint8Array, passphrase: string, options?: OpenOptions): Promise<OpenResult>;
//# sourceMappingURL=age.d.ts.map