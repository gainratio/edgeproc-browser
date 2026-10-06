// Passphrase policy for NEW passphrases (choosing one, not typing an old one).
//
// Unicode: passphrases are compared and measured in NFC form, because the same
// visible text can arrive as different code points (an iPhone keyboard and a
// Windows IME can disagree about "é"). `sealWithPassphrase` seals with the NFC
// form for the same reason. Whitespace is NOT trimmed: a space is a legal
// passphrase character and silently dropping it would change the secret. The one
// exception is a passphrase made only of whitespace, which is reported as
// `empty`, because it is almost always an accident and it is invisible on screen.

/** The default minimum length, in Unicode code points after NFC. */
export const DEFAULT_MIN_PASSPHRASE_LENGTH = 12;

/** Why a new passphrase was refused. */
export type NewPassphraseRejection = "empty" | "too_short" | "mismatch";

export type NewPassphraseCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: NewPassphraseRejection };

export interface NewPassphraseOptions {
	/** Minimum length in code points after NFC. Defaults to 12. */
	readonly minLength?: number;
}

/** The form a passphrase is sealed, compared and measured in. */
export function normalizePassphrase(passphrase: string): string {
	return passphrase.normalize("NFC");
}

function codePointLength(text: string): number {
	return Array.from(text).length;
}

/**
 * Check a passphrase the user is choosing, plus its confirmation.
 * Checks run in order: empty, then too short, then mismatch.
 */
export function checkNewPassphrase(
	passphrase: string,
	confirmation: string,
	options: NewPassphraseOptions = {},
): NewPassphraseCheck {
	const minLength = options.minLength ?? DEFAULT_MIN_PASSPHRASE_LENGTH;
	const normalized = normalizePassphrase(passphrase);
	if (normalized.trim() === "") {
		return { ok: false, reason: "empty" };
	}
	if (codePointLength(normalized) < minLength) {
		return { ok: false, reason: "too_short" };
	}
	if (normalized !== normalizePassphrase(confirmation)) {
		return { ok: false, reason: "mismatch" };
	}
	return { ok: true };
}
