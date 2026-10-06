// @vitest-environment node
//
// The age seam. Tests seal at a low work factor (logN 10, 1 MiB) so the suite
// stays fast; one test seals at the default to pin it. The default's memory and
// timing are measured in real browsers by test/browser/seal.spec.ts.
import { Encrypter } from "age-encryption";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_OPEN_WORK_FACTOR,
	DEFAULT_SCRYPT_WORK_FACTOR,
	isSealed,
	openWithPassphrase,
	sealWithPassphrase,
} from "./age.js";

const FAST = { workFactor: 10 } as const;
const PASS = "correct horse battery staple";
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const PAYLOAD = text("the quick brown fox jumps over the lazy dog");

async function sealed(
	payload: Uint8Array = PAYLOAD,
	passphrase = PASS,
): Promise<Uint8Array> {
	const result = await sealWithPassphrase(payload, passphrase, FAST);
	if (!result.ok) throw new Error(`seal failed: ${result.reason}`);
	return result.bytes;
}

function headerText(file: Uint8Array): string {
	const decoded = new TextDecoder("latin1").decode(file);
	return decoded.slice(0, decoded.indexOf("\n---"));
}

/** Rewrite the scrypt stanza's work factor, keeping every other byte. */
function withWorkFactor(file: Uint8Array, logN: number): Uint8Array {
	const latin = new TextDecoder("latin1").decode(file);
	const rewritten = latin.replace(
		/^(-> scrypt \S+ )\d+$/m,
		(_, prefix: string) => `${prefix}${logN}`,
	);
	return Uint8Array.from(rewritten, (c) => c.charCodeAt(0));
}

describe("sealWithPassphrase", () => {
	it("writes a standard age v1 file with a single scrypt stanza", async () => {
		const file = await sealed();
		const header = headerText(file);
		expect(header.startsWith("age-encryption.org/v1\n")).toBe(true);
		expect(header).toMatch(/^-> scrypt [A-Za-z0-9+/]{22} 10$/m);
		expect(header.match(/^-> /gm)).toHaveLength(1);
	});

	it("defaults to scrypt work factor 17 (128 MiB, the OWASP floor)", async () => {
		expect(DEFAULT_SCRYPT_WORK_FACTOR).toBe(17);
		const result = await sealWithPassphrase(PAYLOAD, PASS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(headerText(result.bytes)).toMatch(/^-> scrypt \S+ 17$/m);
		// One real 128 MiB scrypt; slow under coverage instrumentation.
	}, 60_000);

	it("never writes the same bytes twice (fresh salt and file key)", async () => {
		const a = await sealed();
		const b = await sealed();
		expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
	});

	it("refuses an empty passphrase", async () => {
		expect(await sealWithPassphrase(PAYLOAD, "", FAST)).toEqual({
			ok: false,
			reason: "empty_passphrase",
		});
	});

	it.each([9, 21, 17.5, Number.NaN])(
		"refuses work factor %s (allowed: integers 10..20)",
		async (workFactor) => {
			expect(await sealWithPassphrase(PAYLOAD, PASS, { workFactor })).toEqual({
				ok: false,
				reason: "invalid_work_factor",
			});
		},
	);

	it("accepts the lowest allowed work factor", async () => {
		const low = await sealWithPassphrase(PAYLOAD, PASS, { workFactor: 10 });
		expect(low.ok).toBe(true);
	});

	it("seals an empty payload", async () => {
		const file = await sealed(new Uint8Array(0));
		const opened = await openWithPassphrase(file, PASS);
		expect(opened).toEqual({ ok: true, bytes: new Uint8Array(0) });
	});
});

describe("openWithPassphrase", () => {
	it("round-trips the exact bytes", async () => {
		const payload = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
		const opened = await openWithPassphrase(await sealed(payload), PASS);
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(Buffer.from(opened.bytes).equals(Buffer.from(payload))).toBe(true);
	});

	it("reports a wrong passphrase", async () => {
		expect(await openWithPassphrase(await sealed(), `${PASS}!`)).toEqual({
			ok: false,
			reason: "wrong_passphrase_or_tampered",
		});
	});

	it("reports an empty passphrase as wrong, without throwing", async () => {
		expect(await openWithPassphrase(await sealed(), "")).toEqual({
			ok: false,
			reason: "wrong_passphrase_or_tampered",
		});
	});

	it("reports a flipped payload byte as tampered", async () => {
		const file = await sealed();
		const last = file.length - 1;
		file[last] = (file[last] ?? 0) ^ 0x01;
		expect(await openWithPassphrase(file, PASS)).toEqual({
			ok: false,
			reason: "wrong_passphrase_or_tampered",
		});
	});

	it("reports a changed header MAC as tampered", async () => {
		const latin = new TextDecoder("latin1").decode(await sealed());
		const macStart = latin.indexOf("\n--- ") + 5;
		const flipped = latin[macStart] === "A" ? "B" : "A";
		const edited = `${latin.slice(0, macStart)}${flipped}${latin.slice(macStart + 1)}`;
		const file = Uint8Array.from(edited, (c) => c.charCodeAt(0));
		expect(await openWithPassphrase(file, PASS)).toEqual({
			ok: false,
			reason: "wrong_passphrase_or_tampered",
		});
	});

	it("reports a truncated file as tampered", async () => {
		const file = await sealed();
		expect(await openWithPassphrase(file.slice(0, -10), PASS)).toEqual({
			ok: false,
			reason: "wrong_passphrase_or_tampered",
		});
	});

	it("reports bytes that are not an age file as not_sealed", async () => {
		expect(await openWithPassphrase(text("SQLite format 3\0"), PASS)).toEqual({
			ok: false,
			reason: "not_sealed",
		});
		expect(await openWithPassphrase(new Uint8Array(0), PASS)).toEqual({
			ok: false,
			reason: "not_sealed",
		});
	});

	it("reports an age header with no end as malformed", async () => {
		expect(
			await openWithPassphrase(text("age-encryption.org/v1\n-> scrypt"), PASS),
		).toEqual({ ok: false, reason: "malformed" });
	});

	it("refuses a work factor above the cap before running scrypt", async () => {
		expect(DEFAULT_MAX_OPEN_WORK_FACTOR).toBe(18);
		const costly = withWorkFactor(await sealed(), 19);
		const started = performance.now();
		expect(await openWithPassphrase(costly, PASS)).toEqual({
			ok: false,
			reason: "too_costly",
			workFactor: 19,
		});
		// logN 19 is 512 MiB of scrypt; refusing must not have computed it.
		expect(performance.now() - started).toBeLessThan(200);
	});

	it("opens a file at exactly the cap's work factor when the cap allows it", async () => {
		const file = await sealed();
		expect(
			(await openWithPassphrase(file, PASS, { maxWorkFactor: 10 })).ok,
		).toBe(true);
		expect(await openWithPassphrase(file, PASS, { maxWorkFactor: 9 })).toEqual({
			ok: false,
			reason: "too_costly",
			workFactor: 10,
		});
	});

	it("clamps maxWorkFactor to 20, so a logN 21 file is too_costly, never a wrong passphrase", async () => {
		const file = await sealed();
		for (const logN of [21, 30, 99]) {
			expect(
				await openWithPassphrase(withWorkFactor(file, logN), PASS, {
					maxWorkFactor: 99,
				}),
			).toEqual({ ok: false, reason: "too_costly", workFactor: logN });
		}
	});

	it("treats a NaN maxWorkFactor as the default cap", async () => {
		const costly = withWorkFactor(await sealed(), 19);
		expect(
			await openWithPassphrase(costly, PASS, { maxWorkFactor: Number.NaN }),
		).toEqual({ ok: false, reason: "too_costly", workFactor: 19 });
	});

	it("reports a non-numeric work factor as malformed", async () => {
		const latin = new TextDecoder("latin1").decode(await sealed());
		const edited = latin.replace(/^(-> scrypt \S+ )\d+$/m, "$1ten");
		const file = Uint8Array.from(edited, (c) => c.charCodeAt(0));
		expect(await openWithPassphrase(file, PASS)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("reports an age file sealed to a public key as unsupported", async () => {
		const header =
			"age-encryption.org/v1\n-> X25519 TEiF0ypqr+bpvcqXNyCVJpL7OuwPdVwPL7KQEbFDOCc\nEmECAEcKN+n/Vs9SbWiV+Hu0r+E8R77DdWYyd83nw7U\n--- Vn+54jqiiUCE+WZcEVY3f1sqHjlu/z1LCQ/T7Xm7qI0\n";
		expect(await openWithPassphrase(text(header), PASS)).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	it("opens an ASCII-armored age file", async () => {
		const encrypter = new Encrypter();
		encrypter.setPassphrase(PASS);
		encrypter.setScryptWorkFactor(10);
		const { armor } = await import("age-encryption");
		const armored = text(armor.encode(await encrypter.encrypt(PAYLOAD)));
		expect(isSealed(armored)).toBe(true);
		expect(await openWithPassphrase(armored, PASS)).toEqual({
			ok: true,
			bytes: PAYLOAD,
		});
	});

	it("reports broken armor as malformed", async () => {
		const broken = text(
			"-----BEGIN AGE ENCRYPTED FILE-----\n!!!!\n-----END AGE ENCRYPTED FILE-----\n",
		);
		expect(await openWithPassphrase(broken, PASS)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});

describe("passphrase normalization", () => {
	const nfc = "crème brûlée à la façon";
	const nfd = nfc.normalize("NFD");

	it("seals in NFC, so the NFD spelling of the same text opens it", async () => {
		const file = await sealed(PAYLOAD, nfd);
		expect((await openWithPassphrase(file, nfc)).ok).toBe(true);
		expect((await openWithPassphrase(file, nfd)).ok).toBe(true);
	});

	it("still opens a file another age tool sealed with a non-NFC passphrase", async () => {
		const encrypter = new Encrypter();
		encrypter.setPassphrase(nfd); // as the age CLI would: raw bytes, no NFC
		encrypter.setScryptWorkFactor(10);
		const file = await encrypter.encrypt(PAYLOAD);
		expect(await openWithPassphrase(file, nfd)).toEqual({
			ok: true,
			bytes: PAYLOAD,
		});
	});

	it("does not trim: a trailing space is a different passphrase", async () => {
		const file = await sealed(PAYLOAD, `${PASS} `);
		expect((await openWithPassphrase(file, PASS)).ok).toBe(false);
		expect((await openWithPassphrase(file, `${PASS} `)).ok).toBe(true);
	});
});

describe("isSealed", () => {
	it("recognizes binary age files and nothing else", async () => {
		expect(isSealed(await sealed())).toBe(true);
		expect(isSealed(text("age-encryption.org/v2\n"))).toBe(false);
		expect(isSealed(text("ALMAMESH"))).toBe(false);
		expect(isSealed(new Uint8Array(0))).toBe(false);
	});

	it("recognizes armor with leading whitespace", () => {
		expect(isSealed(text("\n  -----BEGIN AGE ENCRYPTED FILE-----\n"))).toBe(
			true,
		);
	});
});
