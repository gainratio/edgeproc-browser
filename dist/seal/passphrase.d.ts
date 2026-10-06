/** The default minimum length, in Unicode code points after NFC. */
export declare const DEFAULT_MIN_PASSPHRASE_LENGTH = 12;
/** Why a new passphrase was refused. */
export type NewPassphraseRejection = "empty" | "too_short" | "mismatch";
export type NewPassphraseCheck = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly reason: NewPassphraseRejection;
};
export interface NewPassphraseOptions {
    /** Minimum length in code points after NFC. Defaults to 12. */
    readonly minLength?: number;
}
/** The form a passphrase is sealed, compared and measured in. */
export declare function normalizePassphrase(passphrase: string): string;
/**
 * Check a passphrase the user is choosing, plus its confirmation.
 * Checks run in order: empty, then too short, then mismatch.
 */
export declare function checkNewPassphrase(passphrase: string, confirmation: string, options?: NewPassphraseOptions): NewPassphraseCheck;
//# sourceMappingURL=passphrase.d.ts.map