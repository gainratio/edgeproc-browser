// The age seam: the ONLY production module that imports `age-encryption`
// (typage, by age's co-designer). Files are standard age v1 with a single
// scrypt recipient, so `age -d file` opens them with no code of ours.
//
// The library is loaded with a dynamic import on first seal/open, so importing
// this entry for `isSealed` or `checkNewPassphrase` costs nothing. scrypt is
// synchronous and memory-hard: at the default work factor it holds 128 MiB and
// blocks its thread for a fraction of a second. Call seal/open from a Worker.
import { normalizePassphrase } from "./passphrase.js";
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
 * make us allocate more. Raise it per call with `maxWorkFactor` (age caps at 20).
 */
export const DEFAULT_MAX_OPEN_WORK_FACTOR = 18;
const MAGIC = "age-encryption.org/v1\n";
const ARMOR_BEGIN = "-----BEGIN AGE ENCRYPTED FILE-----";
const HEADER_END = "\n---";
let ageModule;
function loadAge() {
    ageModule ??= import("age-encryption");
    return ageModule;
}
function startsWithMagic(bytes) {
    if (bytes.length < MAGIC.length)
        return false;
    for (let i = 0; i < MAGIC.length; i += 1) {
        if (bytes[i] !== MAGIC.charCodeAt(i))
            return false;
    }
    return true;
}
function isArmored(bytes) {
    const head = new TextDecoder().decode(bytes.subarray(0, 1024));
    return head.trimStart().startsWith(ARMOR_BEGIN);
}
/** True for a binary or ASCII-armored age v1 file. Does not authenticate. */
export function isSealed(bytes) {
    return startsWithMagic(bytes) || isArmored(bytes);
}
function validWorkFactor(workFactor) {
    return (Number.isInteger(workFactor) &&
        workFactor >= MIN_SCRYPT_WORK_FACTOR &&
        workFactor <= MAX_SCRYPT_WORK_FACTOR);
}
/**
 * Seal bytes under a passphrase as a standard age v1 file (scrypt recipient).
 * The passphrase is sealed in NFC form. It is not length-checked here: gate
 * new passphrases with `checkNewPassphrase` first.
 */
export async function sealWithPassphrase(plaintext, passphrase, options = {}) {
    const workFactor = options.workFactor ?? DEFAULT_SCRYPT_WORK_FACTOR;
    if (passphrase === "")
        return { ok: false, reason: "empty_passphrase" };
    if (!validWorkFactor(workFactor)) {
        return { ok: false, reason: "invalid_work_factor" };
    }
    const { Encrypter } = await loadAge();
    const encrypter = new Encrypter();
    encrypter.setPassphrase(normalizePassphrase(passphrase));
    encrypter.setScryptWorkFactor(workFactor);
    return { ok: true, bytes: await encrypter.encrypt(plaintext) };
}
/** Read the recipient stanzas without running any crypto. */
function checkHeader(file, maxWorkFactor) {
    const latin = new TextDecoder("latin1").decode(file);
    const end = latin.indexOf(HEADER_END);
    if (end < 0)
        return { ok: false, reason: "malformed" };
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
        if (!/^[1-9][0-9]?$/.test(logN))
            return { ok: false, reason: "malformed" };
        if (Number(logN) > maxWorkFactor)
            return { ok: false, reason: "too_costly" };
    }
    return { ok: true };
}
async function decodeArmor(bytes) {
    const { armor } = await loadAge();
    try {
        return armor.decode(new TextDecoder().decode(bytes));
    }
    catch {
        return undefined;
    }
}
async function tryDecrypt(file, passphrase) {
    const { Decrypter } = await loadAge();
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    try {
        return await decrypter.decrypt(file);
    }
    catch {
        return undefined;
    }
}
/**
 * Candidate spellings to try: NFC first (how we seal), then the input as typed,
 * when different, for files another age tool sealed without normalizing.
 */
function spellings(passphrase) {
    const nfc = normalizePassphrase(passphrase);
    return nfc === passphrase ? [nfc] : [nfc, passphrase];
}
/** Open an age v1 passphrase file. Never throws on bad input. */
export async function openWithPassphrase(sealed, passphrase, options = {}) {
    const binary = isArmored(sealed) ? await decodeArmor(sealed) : sealed;
    if (binary === undefined)
        return { ok: false, reason: "malformed" };
    if (!startsWithMagic(binary))
        return { ok: false, reason: "not_sealed" };
    const header = checkHeader(binary, options.maxWorkFactor ?? DEFAULT_MAX_OPEN_WORK_FACTOR);
    if (!header.ok)
        return header;
    if (passphrase === "") {
        return { ok: false, reason: "wrong_passphrase_or_tampered" };
    }
    for (const candidate of spellings(passphrase)) {
        const bytes = await tryDecrypt(binary, candidate);
        if (bytes !== undefined)
            return { ok: true, bytes };
    }
    return { ok: false, reason: "wrong_passphrase_or_tampered" };
}
//# sourceMappingURL=age.js.map