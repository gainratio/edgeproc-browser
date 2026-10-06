// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	checkNewPassphrase,
	DEFAULT_MIN_PASSPHRASE_LENGTH,
} from "./passphrase";

const ELEVEN = "x".repeat(11);
const TWELVE = "x".repeat(12);

describe("checkNewPassphrase", () => {
	it("pins the default minimum at 12 characters", () => {
		expect(DEFAULT_MIN_PASSPHRASE_LENGTH).toBe(12);
		expect(checkNewPassphrase(ELEVEN, ELEVEN)).toEqual({
			ok: false,
			reason: "too_short",
		});
		expect(checkNewPassphrase(TWELVE, TWELVE)).toEqual({ ok: true });
	});

	it("reports an empty passphrase as empty, not too_short", () => {
		expect(checkNewPassphrase("", "")).toEqual({ ok: false, reason: "empty" });
	});

	it("treats a whitespace-only passphrase as empty", () => {
		const blanks = " \t ".repeat(5);
		expect(checkNewPassphrase(blanks, blanks)).toEqual({
			ok: false,
			reason: "empty",
		});
	});

	it("keeps inner and outer spaces: they are part of the secret", () => {
		const spaced = "  correct horse  ";
		expect(checkNewPassphrase(spaced, spaced)).toEqual({ ok: true });
		expect(checkNewPassphrase(spaced, spaced.trim())).toEqual({
			ok: false,
			reason: "mismatch",
		});
	});

	it("reports a confirmation that differs as mismatch", () => {
		expect(checkNewPassphrase(TWELVE, `${TWELVE}!`)).toEqual({
			ok: false,
			reason: "mismatch",
		});
	});

	it("checks length before the confirmation", () => {
		expect(checkNewPassphrase("short", "other")).toEqual({
			ok: false,
			reason: "too_short",
		});
	});

	it("honours a custom minimum length", () => {
		expect(checkNewPassphrase("abcd", "abcd", { minLength: 4 })).toEqual({
			ok: true,
		});
		expect(checkNewPassphrase(TWELVE, TWELVE, { minLength: 15 })).toEqual({
			ok: false,
			reason: "too_short",
		});
	});

	it("counts code points, not UTF-16 units: 6 emoji are 6 characters", () => {
		const emoji = "🔐".repeat(6); // 12 UTF-16 units, 6 code points
		expect(emoji.length).toBe(12);
		expect(checkNewPassphrase(emoji, emoji)).toEqual({
			ok: false,
			reason: "too_short",
		});
		expect(checkNewPassphrase(emoji, emoji, { minLength: 6 })).toEqual({
			ok: true,
		});
	});

	it("counts length after NFC, so a decomposed accent is one character", () => {
		const decomposed = "é".repeat(11); // 22 code points, 11 after NFC
		expect(checkNewPassphrase(decomposed, decomposed)).toEqual({
			ok: false,
			reason: "too_short",
		});
	});

	it("accepts NFC and NFD spellings of the same passphrase as a match", () => {
		const nfc = "café-crème-brûlée";
		const nfd = nfc.normalize("NFD");
		expect(nfd).not.toBe(nfc);
		expect(checkNewPassphrase(nfc, nfd)).toEqual({ ok: true });
	});
});
