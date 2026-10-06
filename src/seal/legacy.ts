// Read-only openers for the PBKDF2-SHA-256 + AES-256-GCM files our apps wrote
// before `sealWithPassphrase`. Nothing here writes: new files are age files.
//
// Formats (each matched byte for byte against golden files that the apps' own
// current code wrote; see src/seal/__fixtures__/legacy):
// - almamesh-portable-v3: 64-byte binary header ("ALMAMESH" magic), header = AAD.
// - almamesh-backup-v2:   JSON envelope, AAD = a fixed JSON array of the header.
// - almamesh-backup-v1:   JSON envelope, no AAD.
// - amlfilter-install-key-v1: JSON, AAD = a fixed JSON array of the header.
//
// Every format reads the iteration count STORED in the file, bounded to
// [100,000, 10,000,000] (aml-filter's rule): below is a downgrade, above is a
// file that would burn the CPU. The passphrase is used as typed first (the
// writers never normalized), then in NFC and NFD forms if those differ.

import { normalizePassphrase } from "./passphrase.js";
import type { OpenFailure } from "./types.js";

export const LEGACY_MIN_ITERATIONS = 100_000;
export const LEGACY_MAX_ITERATIONS = 10_000_000;

export type LegacyFormat =
	| "almamesh-portable-v3"
	| "almamesh-backup-v2"
	| "almamesh-backup-v1"
	| "amlfilter-install-key-v1";

export type LegacyOpenResult =
	| {
			readonly ok: true;
			/** The decrypted payload, exactly as the app encrypted it. */
			readonly bytes: Uint8Array;
			readonly format: LegacyFormat;
	  }
	| { readonly ok: false; readonly reason: OpenFailure };

interface Envelope {
	readonly format: LegacyFormat;
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly iv: Uint8Array<ArrayBuffer>;
	readonly iterations: number;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
	readonly additionalData?: Uint8Array<ArrayBuffer>;
	readonly plaintextLength?: number;
}

type Parsed =
	| { readonly ok: true; readonly envelope: Envelope }
	| { readonly ok: false; readonly reason: OpenFailure };

type JsonObject = Readonly<Record<string, unknown>>;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const V3_MAGIC = "ALMAMESH";
const V3_VERSION = 3;
const V3_HEADER_BYTES = 64;
const V3_MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

const fail = (reason: OpenFailure): { ok: false; reason: OpenFailure } => ({
	ok: false,
	reason,
});

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIterations(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= LEGACY_MIN_ITERATIONS &&
		value <= LEGACY_MAX_ITERATIONS
	);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
	try {
		return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- v3 binary

function hasV3Magic(bytes: Uint8Array): boolean {
	return (
		bytes.length >= V3_MAGIC.length &&
		Array.from(V3_MAGIC).every((c, i) => bytes[i] === c.charCodeAt(0))
	);
}

function v3HeaderShape(
	header: Uint8Array<ArrayBuffer>,
): OpenFailure | undefined {
	const version = new DataView(header.buffer).getUint8(8);
	if (version > V3_VERSION || header[9] !== 1 || header[10] !== 1) {
		return "unsupported";
	}
	const reservedClear =
		header[13] === 0 && header[14] === 0 && header[15] === 0;
	const shaped =
		version === V3_VERSION &&
		header[11] === SALT_BYTES &&
		header[12] === IV_BYTES &&
		reservedClear;
	return shaped ? undefined : "malformed";
}

function parseV3(bytes: Uint8Array): Parsed {
	if (bytes.length < V3_HEADER_BYTES + TAG_BYTES) return fail("malformed");
	const header = bytes.slice(0, V3_HEADER_BYTES);
	const view = new DataView(header.buffer);
	const shape = v3HeaderShape(header);
	if (shape !== undefined) return fail(shape);
	const iterations = view.getUint32(16, false);
	if (!validIterations(iterations)) return fail("unsupported");
	const plaintextLength = view.getUint32(28, false);
	if (plaintextLength > V3_MAX_PLAINTEXT_BYTES) return fail("too_large");
	const ciphertextLength = view.getUint32(32, false);
	const consistent =
		ciphertextLength === plaintextLength + TAG_BYTES &&
		bytes.length === V3_HEADER_BYTES + ciphertextLength;
	if (!consistent) return fail("malformed");
	const envelope: Envelope = {
		format: "almamesh-portable-v3",
		salt: header.slice(36, 36 + SALT_BYTES),
		iv: header.slice(52, 52 + IV_BYTES),
		iterations,
		ciphertext: bytes.slice(V3_HEADER_BYTES),
		additionalData: header,
		plaintextLength,
	};
	return { ok: true, envelope };
}

// ------------------------------------------------------------- JSON formats

interface Pbkdf2Fields {
	readonly salt: Uint8Array<ArrayBuffer>;
	readonly iv: Uint8Array<ArrayBuffer>;
	readonly ciphertext: Uint8Array<ArrayBuffer>;
	readonly iterations: number;
}

/** The KDF block both apps share: PBKDF2 / SHA-256 / bounded iterations. */
function kdfFailure(kdf: unknown): OpenFailure | undefined {
	if (!isObject(kdf) || typeof kdf.salt !== "string") return "malformed";
	const supported =
		kdf.name === "PBKDF2" &&
		kdf.hash === "SHA-256" &&
		validIterations(kdf.iterations);
	return supported ? undefined : "unsupported";
}

/** `salt` was already checked to be a string by `kdfFailure`. */
function decodeFields(
	salt: string,
	iv: unknown,
	ciphertext: unknown,
	iterations: number,
): Pbkdf2Fields | undefined {
	if (typeof iv !== "string" || typeof ciphertext !== "string")
		return undefined;
	const decoded = {
		salt: fromBase64(salt),
		iv: fromBase64(iv),
		ciphertext: fromBase64(ciphertext),
	};
	const { salt: s, iv: i, ciphertext: c } = decoded;
	if (s === undefined || i === undefined || c === undefined) return undefined;
	if (s.length !== SALT_BYTES || i.length !== IV_BYTES) return undefined;
	return { salt: s, iv: i, ciphertext: c, iterations };
}

const encodeJson = (value: unknown): Uint8Array<ArrayBuffer> =>
	new TextEncoder().encode(JSON.stringify(value));

/** almamesh portableBundle.ts `legacyHeaderBytes`, field for field. */
function almameshV2AdditionalData(
	file: JsonObject,
	kdf: JsonObject,
): Uint8Array<ArrayBuffer> | undefined {
	const app = file.app;
	if (!isObject(app) || typeof app.version !== "string") return undefined;
	if (typeof file.exportedAt !== "string") return undefined;
	return encodeJson([
		file.format,
		file.formatVersion,
		app.version,
		file.exportedAt,
		file.encryption,
		kdf.name,
		kdf.hash,
		kdf.iterations,
		kdf.salt,
		file.iv,
	]);
}

function almameshVersionFailure(version: unknown): OpenFailure | undefined {
	if (version === 1 || version === 2) return undefined;
	return typeof version === "number" && version > 2
		? "unsupported"
		: "malformed";
}

function parseAlmameshJson(file: JsonObject): Parsed {
	const versionFailure = almameshVersionFailure(file.formatVersion);
	if (versionFailure !== undefined) return fail(versionFailure);
	if (file.encryption === "none") return fail("not_sealed");
	if (file.encryption !== "aes-gcm") return fail("malformed");
	const kdfProblem = kdfFailure(file.kdf);
	if (kdfProblem !== undefined) return fail(kdfProblem);
	const kdf = file.kdf as JsonObject;
	const fields = decodeFields(
		kdf.salt as string,
		file.iv,
		file.ciphertext,
		kdf.iterations as number,
	);
	if (fields === undefined) return fail("malformed");
	if (file.formatVersion === 1) {
		return { ok: true, envelope: { format: "almamesh-backup-v1", ...fields } };
	}
	const additionalData = almameshV2AdditionalData(file, kdf);
	if (additionalData === undefined) return fail("malformed");
	const envelope: Envelope = {
		format: "almamesh-backup-v2",
		...fields,
		additionalData,
	};
	return { ok: true, envelope };
}

/** aml-filter installKeyExport.ts `additionalData`, field for field. */
function installKeyAdditionalData(
	file: JsonObject,
	kdf: JsonObject,
	cipher: JsonObject,
): Uint8Array<ArrayBuffer> {
	return encodeJson([
		file.format,
		file.version,
		file.public_key_hex,
		kdf.name,
		kdf.hash,
		kdf.iterations,
		kdf.salt,
		cipher.name,
		cipher.iv,
	]);
}

function installKeyShaped(file: JsonObject): boolean {
	const cipher = file.cipher;
	return (
		typeof file.public_key_hex === "string" &&
		HEX64.test(file.public_key_hex) &&
		isObject(cipher) &&
		cipher.name === "AES-GCM"
	);
}

function parseInstallKey(file: JsonObject): Parsed {
	if (file.version !== 1) return fail("unsupported");
	if (!installKeyShaped(file)) return fail("malformed");
	const kdfProblem = kdfFailure(file.kdf);
	if (kdfProblem !== undefined) return fail(kdfProblem);
	const kdf = file.kdf as JsonObject;
	const cipher = file.cipher as JsonObject;
	const fields = decodeFields(
		kdf.salt as string,
		cipher.iv,
		file.ciphertext,
		kdf.iterations as number,
	);
	if (fields === undefined) return fail("malformed");
	const envelope: Envelope = {
		format: "amlfilter-install-key-v1",
		...fields,
		additionalData: installKeyAdditionalData(file, kdf, cipher),
	};
	return { ok: true, envelope };
}

function parseJsonObject(bytes: Uint8Array): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function parse(bytes: Uint8Array): Parsed {
	if (hasV3Magic(bytes)) return parseV3(bytes);
	const file = parseJsonObject(bytes);
	if (file?.format === "almamesh-backup") return parseAlmameshJson(file);
	if (file?.format === "amlfilter.install-key") return parseInstallKey(file);
	return fail("not_sealed");
}

// ------------------------------------------------------------------ decrypt

async function decrypt(
	envelope: Envelope,
	passphrase: string,
): Promise<Uint8Array | undefined> {
	const subtle = globalThis.crypto.subtle;
	try {
		const material = await subtle.importKey(
			"raw",
			new TextEncoder().encode(passphrase),
			"PBKDF2",
			false,
			["deriveKey"],
		);
		const key = await subtle.deriveKey(
			{
				name: "PBKDF2",
				hash: "SHA-256",
				salt: envelope.salt,
				iterations: envelope.iterations,
			},
			material,
			{ name: "AES-GCM", length: 256 },
			false,
			["decrypt"],
		);
		const params: AesGcmParams = { name: "AES-GCM", iv: envelope.iv };
		if (envelope.additionalData !== undefined) {
			params.additionalData = envelope.additionalData;
		}
		return new Uint8Array(
			await subtle.decrypt(params, key, envelope.ciphertext),
		);
	} catch {
		return undefined;
	}
}

/**
 * The writers never normalized, so the file holds whatever form the keyboard
 * produced that day. Try the input as typed, then NFC, then NFD (PBKDF2 is
 * cheap enough for three tries; scrypt in age.ts is not, so it tries fewer).
 */
function spellings(passphrase: string): readonly string[] {
	const forms = [
		passphrase,
		normalizePassphrase(passphrase),
		passphrase.normalize("NFD"),
	];
	return [...new Set(forms)];
}

/**
 * Open a file written by an older app version (almamesh portable v3, almamesh
 * backup v1/v2, aml-filter install-key v1). Read-only: never use these formats
 * to write. JSON formats may be passed as bytes or text. Never throws on bad
 * input; the payload comes back exactly as the app encrypted it, and the app
 * applies its own checks (for example aml-filter's public-key match).
 */
export async function openLegacyPbkdf2AesGcm(
	file: Uint8Array | string,
	passphrase: string,
): Promise<LegacyOpenResult> {
	const bytes =
		typeof file === "string" ? new TextEncoder().encode(file) : file;
	const parsed = parse(bytes);
	if (!parsed.ok) return parsed;
	const { envelope } = parsed;
	if (passphrase === "") return fail("wrong_passphrase_or_tampered");
	for (const candidate of spellings(passphrase)) {
		const plain = await decrypt(envelope, candidate);
		const lengthOk =
			envelope.plaintextLength === undefined ||
			plain?.length === envelope.plaintextLength;
		if (plain !== undefined && lengthOk) {
			return { ok: true, bytes: plain, format: envelope.format };
		}
	}
	return fail("wrong_passphrase_or_tampered");
}
