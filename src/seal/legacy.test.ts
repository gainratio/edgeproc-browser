// @vitest-environment node
//
// Back-compat contract: the golden fixtures in __fixtures__/legacy were made by
// the CURRENT almamesh and aml-filter code (scripts/generate-legacy-seal-fixtures.mjs
// runs their real encrypt functions, then opens each file with their real
// readers). If one of these stops opening, a user's old backup stops opening.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	LEGACY_MAX_ITERATIONS,
	LEGACY_MIN_ITERATIONS,
	type LegacyFormat,
	openLegacyPbkdf2AesGcm,
} from "./legacy.js";

const DIR = join(__dirname, "__fixtures__", "legacy");

interface FixtureEntry {
	readonly file: string;
	readonly format: LegacyFormat;
	readonly passphrase: string;
	readonly iterations: number;
	readonly plaintextSha256: string;
}

const manifest = JSON.parse(
	readFileSync(join(DIR, "manifest.json"), "utf8"),
) as { readonly fixtures: readonly FixtureEntry[] };

const bytesOf = (entry: FixtureEntry): Uint8Array =>
	new Uint8Array(readFileSync(join(DIR, entry.file)));
const fixture = (format: LegacyFormat): FixtureEntry => {
	const entry = manifest.fixtures.find((f) => f.format === format);
	if (entry === undefined) throw new Error(`no fixture for ${format}`);
	return entry;
};
const sha256 = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");
const jsonOf = (entry: FixtureEntry): Record<string, unknown> =>
	JSON.parse(new TextDecoder().decode(bytesOf(entry))) as Record<
		string,
		unknown
	>;
const encode = (value: unknown): Uint8Array =>
	new TextEncoder().encode(JSON.stringify(value));

const WRONG = { ok: false, reason: "wrong_passphrase_or_tampered" } as const;

describe("golden fixtures from the current almamesh and aml-filter code", () => {
	it("covers all four legacy formats", () => {
		expect(manifest.fixtures.map((f) => f.format).sort()).toEqual([
			"almamesh-backup-v1",
			"almamesh-backup-v2",
			"almamesh-portable-v3",
			"amlfilter-install-key-v1",
		]);
	});

	it.each(manifest.fixtures.map((f) => [f.format, f] as const))(
		"%s opens with its passphrase to the exact original plaintext",
		async (format, entry) => {
			const result = await openLegacyPbkdf2AesGcm(
				bytesOf(entry),
				entry.passphrase,
			);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.format).toBe(format);
			expect(sha256(result.bytes)).toBe(entry.plaintextSha256);
		},
	);

	it.each(manifest.fixtures.map((f) => [f.format, f] as const))(
		"%s refuses a wrong passphrase",
		async (_format, entry) => {
			expect(
				await openLegacyPbkdf2AesGcm(bytesOf(entry), `${entry.passphrase}x`),
			).toEqual(WRONG);
		},
	);

	it("v1 uses the iteration count stored in the file (210,000), not a constant", () => {
		expect(fixture("almamesh-backup-v1").iterations).toBe(210_000);
		expect(jsonOf(fixture("almamesh-backup-v1")).kdf).toMatchObject({
			iterations: 210_000,
		});
		expect(fixture("almamesh-portable-v3").iterations).toBe(600_000);
	});

	it("accepts JSON formats as text as well as bytes", async () => {
		const entry = fixture("amlfilter-install-key-v1");
		const text = new TextDecoder().decode(bytesOf(entry));
		expect((await openLegacyPbkdf2AesGcm(text, entry.passphrase)).ok).toBe(
			true,
		);
	});

	it("opens the NFD-typed v1 fixture when the passphrase is typed in NFC", async () => {
		const entry = fixture("almamesh-backup-v1");
		expect(entry.passphrase.normalize("NFC")).not.toBe(entry.passphrase);
		const result = await openLegacyPbkdf2AesGcm(
			bytesOf(entry),
			entry.passphrase.normalize("NFC"),
		);
		expect(result.ok).toBe(true);
	});

	it("refuses an empty passphrase as wrong", async () => {
		const entry = fixture("almamesh-backup-v2");
		expect(await openLegacyPbkdf2AesGcm(bytesOf(entry), "")).toEqual(WRONG);
	});
});

describe("almamesh portable v3 binary", () => {
	const entry = fixture("almamesh-portable-v3");
	const edited = (edit: (bytes: Uint8Array, view: DataView) => void) => {
		const bytes = bytesOf(entry);
		edit(bytes, new DataView(bytes.buffer, bytes.byteOffset));
		return openLegacyPbkdf2AesGcm(bytes, entry.passphrase);
	};

	it("treats the header as authenticated data: a changed timestamp fails", async () => {
		expect(await edited((b) => (b[27] = (b[27] ?? 0) ^ 1))).toEqual(WRONG);
	});

	it("refuses a flipped ciphertext byte", async () => {
		expect(await edited((b) => (b[100] = (b[100] ?? 0) ^ 1))).toEqual(WRONG);
	});

	it.each([LEGACY_MIN_ITERATIONS - 1, LEGACY_MAX_ITERATIONS + 1, 0])(
		"refuses stored iterations %s before deriving a key",
		async (iterations) => {
			expect(
				await edited((_, view) => view.setUint32(16, iterations, false)),
			).toEqual({ ok: false, reason: "unsupported" });
		},
	);

	it("reads in-range stored iterations instead of pinning 600,000", async () => {
		// 600,001 is in range, so the file is authenticated with that count;
		// since it was sealed with 600,000 the header no longer matches.
		expect(
			await edited((_, view) => view.setUint32(16, 600_001, false)),
		).toEqual(WRONG);
	});

	it("refuses a newer version and other KDF or cipher ids", async () => {
		const unsupported = { ok: false, reason: "unsupported" };
		expect(await edited((b) => (b[8] = 4))).toEqual(unsupported);
		expect(await edited((b) => (b[9] = 2))).toEqual(unsupported);
		expect(await edited((b) => (b[10] = 2))).toEqual(unsupported);
	});

	it("reports damaged header fields as malformed", async () => {
		const malformed = { ok: false, reason: "malformed" };
		expect(await edited((b) => (b[8] = 2))).toEqual(malformed);
		expect(await edited((b) => (b[11] = 8))).toEqual(malformed);
		expect(await edited((b) => (b[12] = 16))).toEqual(malformed);
		expect(await edited((b) => (b[14] = 1))).toEqual(malformed);
		expect(await edited((_, view) => view.setUint32(32, 17, false))).toEqual(
			malformed,
		);
	});

	it("reports a plaintext length over 64 MiB as too_large", async () => {
		expect(
			await edited((_, view) =>
				view.setUint32(28, 64 * 1024 * 1024 + 1, false),
			),
		).toEqual({ ok: false, reason: "too_large" });
	});

	it("reports a truncated file as malformed", async () => {
		const bytes = bytesOf(entry);
		expect(
			await openLegacyPbkdf2AesGcm(bytes.slice(0, 70), entry.passphrase),
		).toEqual({ ok: false, reason: "malformed" });
		expect(
			await openLegacyPbkdf2AesGcm(bytes.slice(0, -1), entry.passphrase),
		).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("almamesh backup v2 JSON", () => {
	const entry = fixture("almamesh-backup-v2");
	const open = (file: Record<string, unknown>) =>
		openLegacyPbkdf2AesGcm(encode(file), entry.passphrase);

	it("authenticates the header: a changed app version fails", async () => {
		expect(await open({ ...jsonOf(entry), app: { version: "9.9.9" } })).toEqual(
			WRONG,
		);
	});

	it("reports a salt of the wrong length as malformed", async () => {
		const file = jsonOf(entry);
		const kdf = { ...(file.kdf as object), salt: btoa("short") };
		expect(await open({ ...file, kdf })).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("reports invalid base64 as malformed", async () => {
		expect(await open({ ...jsonOf(entry), ciphertext: "%%%" })).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("refuses an out-of-range iteration count", async () => {
		const file = jsonOf(entry);
		const kdf = { ...(file.kdf as object), iterations: 50_000 };
		expect(await open({ ...file, kdf })).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	it("refuses a newer formatVersion", async () => {
		expect(await open({ ...jsonOf(entry), formatVersion: 3 })).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	it.each([
		["a missing kdf", { kdf: undefined }],
		["a non-numeric formatVersion", { formatVersion: "2" }],
		["another encryption name", { encryption: "rot13" }],
		["a missing iv", { iv: undefined }],
		["a missing app version", { app: {} }],
		["a missing exportedAt", { exportedAt: undefined }],
	])("reports %s as malformed", async (_label, change) => {
		expect(await open({ ...jsonOf(entry), ...change })).toEqual({
			ok: false,
			reason: "malformed",
		});
	});
});

describe("almamesh backup v1 JSON", () => {
	const entry = fixture("almamesh-backup-v1");
	const open = (file: Record<string, unknown>) =>
		openLegacyPbkdf2AesGcm(encode(file), entry.passphrase);
	const withIterations = (iterations: unknown) => {
		const file = jsonOf(entry);
		return open({ ...file, kdf: { ...(file.kdf as object), iterations } });
	};

	it("derives with the stored count: a different count is a different key", async () => {
		expect(await withIterations(600_000)).toEqual(WRONG);
	});

	it.each([
		LEGACY_MIN_ITERATIONS - 1,
		LEGACY_MAX_ITERATIONS + 1,
		1.5,
		"210000",
	])("refuses stored iterations %s", async (iterations) => {
		expect(await withIterations(iterations)).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	it("refuses a flipped ciphertext character", async () => {
		const file = jsonOf(entry);
		const ciphertext = String(file.ciphertext);
		const flipped = ciphertext.startsWith("A") ? "B" : "A";
		expect(
			await open({ ...file, ciphertext: flipped + ciphertext.slice(1) }),
		).toEqual(WRONG);
	});

	it("reports an unencrypted v1 backup as not_sealed", async () => {
		expect(
			await open({
				format: "almamesh-backup",
				formatVersion: 1,
				encryption: "none",
				stores: {},
			}),
		).toEqual({ ok: false, reason: "not_sealed" });
	});

	it("reports a missing ciphertext as malformed", async () => {
		const { ciphertext: _dropped, ...rest } = jsonOf(entry);
		expect(await open(rest)).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("aml-filter install-key export v1", () => {
	const entry = fixture("amlfilter-install-key-v1");
	const open = (file: Record<string, unknown>) =>
		openLegacyPbkdf2AesGcm(encode(file), entry.passphrase);

	it("authenticates the header: a relabelled public key fails", async () => {
		const file = jsonOf(entry);
		expect(await open({ ...file, public_key_hex: "ab".repeat(32) })).toEqual(
			WRONG,
		);
	});

	it("ignores exported_at, which is outside the authenticated header", async () => {
		expect(
			(await open({ ...jsonOf(entry), exported_at: "1999-01-01T00:00:00Z" }))
				.ok,
		).toBe(true);
	});

	it("refuses iterations above 10,000,000", async () => {
		const file = jsonOf(entry);
		const kdf = { ...(file.kdf as object), iterations: 20_000_000 };
		expect(await open({ ...file, kdf })).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	it("refuses another version", async () => {
		expect(await open({ ...jsonOf(entry), version: 2 })).toEqual({
			ok: false,
			reason: "unsupported",
		});
	});

	it("reports invalid base64 ciphertext as malformed", async () => {
		expect(await open({ ...jsonOf(entry), ciphertext: "%%%" })).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("reports a bad public key or cipher as malformed", async () => {
		const malformed = { ok: false, reason: "malformed" };
		expect(await open({ ...jsonOf(entry), public_key_hex: "xyz" })).toEqual(
			malformed,
		);
		expect(
			await open({ ...jsonOf(entry), cipher: { name: "AES-CBC", iv: "" } }),
		).toEqual(malformed);
	});
});

describe("unrecognized input", () => {
	it.each([
		["empty bytes", new Uint8Array(0)],
		["random bytes", new Uint8Array([1, 2, 3, 4, 5])],
		["JSON that is not an object", encode([1, 2])],
		["JSON of another format", encode({ format: "something-else" })],
		["an age file", new TextEncoder().encode("age-encryption.org/v1\n")],
	])("reports %s as not_sealed", async (_label, bytes) => {
		expect(await openLegacyPbkdf2AesGcm(bytes, "pass")).toEqual({
			ok: false,
			reason: "not_sealed",
		});
	});
});
