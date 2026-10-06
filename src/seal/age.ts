// The age seam: the ONLY production module that imports `age-encryption`
// (typage, by age's co-designer). Files are standard age v1 with a single
// scrypt recipient, so `age -d file` opens them with no code of ours.
//
// The library is loaded with a dynamic import on first seal/open, so importing
// this entry for `isSealed` or `checkNewPassphrase` costs nothing. scrypt is
// synchronous and memory-hard: at the default work factor it holds 128 MiB and
// blocks its thread for a fraction of a second. Call seal/open from a Worker.

import { normalizePassphrase } from "./passphrase.js";
import type { OpenResult, SealResult } from "./types.js";

/**
 * scrypt work factor (log2 N, r=8, p=1) for new files: 17 = 128 MiB, the
 * OWASP Password Storage floor for scrypt. age's CLI default is 18 (256 MiB);
 * we stay one step lower because low-memory phones (the iPhone OOM history in
 * our apps) are the devices that must not crash.
 */
export const DEFAULT_SCRYPT_WORK_FACTOR = 17;
/** Allowed range for `workFactor` when sealing. Below 16 is for tests only. */
export const MIN_SCRYPT_WORK_FACTOR = 10;
export const MAX_SCRYPT_WORK_FACTOR = 20;
/**
 * Highest work factor `openWithPassphrase` will compute by default: 18
 * (256 MiB) opens files made by the age CLI's default; a hostile file cannot
 * make us allocate more. Raise it per call with `maxWorkFactor`; values above
 * 20 (age's own ceiling) are clamped to 20.
 */
export const DEFAULT_MAX_OPEN_WORK_FACTOR = 18;

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

const MAGIC = "age-encryption.org/v1\n";
const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const HEADER_END = "\n---";

type AgeModule = typeof import("age-encryption");
let ageModule: Promise<AgeModule> | undefined;

/** Load the library once; a failed load is forgotten so the next call retries. */
function loadAge(): Promise<AgeModule> {
	ageModule ??= import("age-encryption").catch((error: unknown) => {
		ageModule = undefined;
		throw error;
	});
	return ageModule;
}

/** A failure that says nothing about the passphrase. */
type DeviceFailure = "out_of_memory" | "unavailable";

/**
 * scrypt's allocation failing: RangeError in V8 ("Array buffer allocation
 * failed") and WebKit ("Out of memory"), InternalError in Firefox.
 */
function isOutOfMemory(error: unknown): boolean {
	if (error instanceof RangeError) return true;
	return (
		error instanceof Error &&
		error.name === "InternalError" &&
		/out of memory|allocation/i.test(error.message)
	);
}

function deviceFailure(error: unknown): DeviceFailure {
	return isOutOfMemory(error) ? "out_of_memory" : "unavailable";
}

// typage 0.3.x (and the @noble/@scure code it calls) throws plain `Error`s, so
// its messages are the only signal. Collected from typage's source and from
// flipping/truncating every region of real files (see age.failures.test.ts).
/** Authentication failed: wrong passphrase, or the bytes were changed. */
const AUTH_FAILURES: readonly RegExp[] = [
	/^no identity matched any of the file's recipients$/,
	/^invalid header HMAC$/,
	/^invalid tag$/,
	/^final chunk is empty$/,
	/^ciphertext is too small$/,
	/^ciphertext size is invalid$/,
	/^"ciphertext" expected length >= tagLength=/,
	/^stream ended before reading \d+ bytes$/,
];
/** The header failed to parse; nothing about the passphrase was learned. */
const HEADER_FAILURES: readonly RegExp[] = [
	/^invalid (scrypt )?stanza$/,
	/^invalid header$/,
	/^invalid non-ASCII byte in header$/,
	/^invalid version /,
	/^scrypt recipient is not the only one in the header$/,
	/^Unknown letter /,
	/^Non-zero padding/,
];

function matches(error: unknown, patterns: readonly RegExp[]): boolean {
	return (
		error instanceof Error && patterns.some((re) => re.test(error.message))
	);
}

/** Map a library error to a reason. Only authentication failures blame the passphrase. */
function openFailure(
	error: unknown,
): "wrong_passphrase_or_tampered" | "malformed" | DeviceFailure {
	if (matches(error, AUTH_FAILURES)) return "wrong_passphrase_or_tampered";
	if (matches(error, HEADER_FAILURES)) return "malformed";
	return deviceFailure(error);
}

function startsWithMagic(bytes: Uint8Array): boolean {
	if (bytes.length < MAGIC.length) return false;
	for (let i = 0; i < MAGIC.length; i += 1) {
		if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
	}
	return true;
}

function isArmored(bytes: Uint8Array): boolean {
	const head = new TextDecoder().decode(bytes.subarray(0, 1024));
	return head.trimStart().startsWith(ARMOR_BEGIN);
}

/** True for a binary or ASCII-armored age v1 file. Does not authenticate. */
export function isSealed(bytes: Uint8Array): boolean {
	return startsWithMagic(bytes) || isArmored(bytes);
}

function validWorkFactor(workFactor: number): boolean {
	return (
		Number.isInteger(workFactor) &&
		workFactor >= MIN_SCRYPT_WORK_FACTOR &&
		workFactor <= MAX_SCRYPT_WORK_FACTOR
	);
}

/**
 * Seal bytes under a passphrase as a standard age v1 file (scrypt recipient).
 * The passphrase is sealed in NFC form. It is not length-checked here: gate
 * new passphrases with `checkNewPassphrase` first.
 */
export async function sealWithPassphrase(
	plaintext: Uint8Array,
	passphrase: string,
	options: SealOptions = {},
): Promise<SealResult> {
	const workFactor = options.workFactor ?? DEFAULT_SCRYPT_WORK_FACTOR;
	if (passphrase === "") return { ok: false, reason: "empty_passphrase" };
	if (!validWorkFactor(workFactor)) {
		return { ok: false, reason: "invalid_work_factor" };
	}
	try {
		const { Encrypter } = await loadAge();
		const encrypter = new Encrypter();
		encrypter.setPassphrase(normalizePassphrase(passphrase));
		encrypter.setScryptWorkFactor(workFactor);
		return { ok: true, bytes: await encrypter.encrypt(plaintext) };
	} catch (error) {
		return { ok: false, reason: deviceFailure(error) };
	}
}

type HeaderCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly reason: "malformed" | "unsupported" }
	| {
			readonly ok: false;
			readonly reason: "too_costly";
			readonly workFactor: number;
	  };

function openCap(maxWorkFactor: number | undefined): number {
	const requested = maxWorkFactor ?? DEFAULT_MAX_OPEN_WORK_FACTOR;
	if (Number.isNaN(requested)) return DEFAULT_MAX_OPEN_WORK_FACTOR;
	return Math.min(requested, MAX_SCRYPT_WORK_FACTOR);
}

/** Read the recipient stanzas without running any crypto. */
function checkHeader(file: Uint8Array, maxWorkFactor: number): HeaderCheck {
	const latin = new TextDecoder("latin1").decode(file);
	const end = latin.indexOf(HEADER_END);
	if (end < 0) return { ok: false, reason: "malformed" };
	const stanzas = latin
		.slice(0, end)
		.split("\n")
		.filter((line) => line.startsWith("-> "))
		.map((line) => line.slice(3).split(" "));
	if (stanzas.some((args) => args[0] !== "scrypt")) {
		return { ok: false, reason: "unsupported" };
	}
	for (const args of stanzas) {
		const logN = args[2] ?? "";
		if (!/^[1-9][0-9]?$/.test(logN)) return { ok: false, reason: "malformed" };
		const workFactor = Number(logN);
		if (workFactor > maxWorkFactor) {
			return { ok: false, reason: "too_costly", workFactor };
		}
	}
	return { ok: true };
}

type Decoded =
	| { readonly ok: true; readonly bytes: Uint8Array }
	| { readonly ok: false; readonly reason: "malformed" | DeviceFailure };

async function decodeArmor(bytes: Uint8Array): Promise<Decoded> {
	let age: AgeModule;
	try {
		age = await loadAge();
	} catch (error) {
		return { ok: false, reason: deviceFailure(error) };
	}
	try {
		return {
			ok: true,
			bytes: age.armor.decode(new TextDecoder().decode(bytes)),
		};
	} catch {
		return { ok: false, reason: "malformed" };
	}
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

/**
 * Read the plaintext ourselves. Given bytes, typage collects the output with
 * `new Response(stream).arrayBuffer()`, and browsers replace the payload's
 * "invalid tag" with their own error (Chromium: TypeError "Failed to fetch",
 * Firefox: AbortError), which would hide a tampered file's real reason.
 */
async function readAllChunks(
	plaintext: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = plaintext.getReader();
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		chunks.push(next.value);
		length += next.value.length;
	}
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function tryDecrypt(
	file: Uint8Array,
	passphrase: string,
): Promise<OpenResult> {
	try {
		const { Decrypter } = await loadAge();
		const decrypter = new Decrypter();
		decrypter.addPassphrase(passphrase);
		const plaintext = await decrypter.decrypt(streamOf(file));
		return { ok: true, bytes: await readAllChunks(plaintext) };
	} catch (error) {
		return { ok: false, reason: openFailure(error) };
	}
}

/**
 * Candidate spellings to try: NFC first (how we seal), then the input as typed,
 * when different, for files another age tool sealed without normalizing.
 */
function spellings(passphrase: string): readonly string[] {
	const nfc = normalizePassphrase(passphrase);
	return nfc === passphrase ? [nfc] : [nfc, passphrase];
}

/** Open an age v1 passphrase file. Never throws on bad input. */
export async function openWithPassphrase(
	sealed: Uint8Array,
	passphrase: string,
	options: OpenOptions = {},
): Promise<OpenResult> {
	const decoded: Decoded = isArmored(sealed)
		? await decodeArmor(sealed)
		: { ok: true, bytes: sealed };
	if (!decoded.ok) return decoded;
	const binary = decoded.bytes;
	if (!startsWithMagic(binary)) return { ok: false, reason: "not_sealed" };
	const header = checkHeader(binary, openCap(options.maxWorkFactor));
	if (!header.ok) return header;
	if (passphrase === "") {
		return { ok: false, reason: "wrong_passphrase_or_tampered" };
	}
	let result: OpenResult = {
		ok: false,
		reason: "wrong_passphrase_or_tampered",
	};
	for (const candidate of spellings(passphrase)) {
		result = await tryDecrypt(binary, candidate);
		// Only a failed authentication is worth retrying with the other spelling.
		if (result.ok || result.reason !== "wrong_passphrase_or_tampered") break;
	}
	return result;
}
