# Passphrase files (`@gainratio/browser/seal`)

**TL;DR:** encrypt bytes with a passphrase into a standard [age](https://age-encryption.org/v1)
file, open it again, and keep opening the older PBKDF2 + AES-GCM files our apps wrote before.
A user can also open a sealed file without your app: `age -d backup.age > backup.sqlite`.

## Why

Backups and key exports leave the browser, so they need a passphrase. Before 0.4.0 each app
hand-rolled that with PBKDF2 and AES-GCM in its own file layout, with its own iteration count
and its own minimum length. This entry replaces that with one published format:

- **age v1 is a spec with several independent implementations** (Go `age`, Rust `rage`, and
  `age-encryption`, the TypeScript one by age's co-designer, which this entry wraps). Nobody
  has to trust or maintain our own file format.
- **Its passphrase KDF, scrypt, is memory-hard.** PBKDF2 is not: a GPU can guess PBKDF2
  passphrases far more cheaply.
- **Results are typed.** Every failure comes back as a `reason`, never as a library error.

## Quickstart

Run seal and open in a Worker. scrypt is synchronous: at the default setting it holds
128 MiB and blocks its thread for about half a second (see the timings below).

```ts
// backup-worker.ts
import { openWithPassphrase, sealWithPassphrase } from "@gainratio/browser/seal";

self.onmessage = async ({ data }) => {
  if (data.kind === "seal") {
    const result = await sealWithPassphrase(data.bytes, data.passphrase);
    self.postMessage(result); // { ok: true, bytes } or { ok: false, reason }
  } else {
    const result = await openWithPassphrase(data.bytes, data.passphrase);
    self.postMessage(result); // { ok: true, bytes } or { ok: false, reason: "wrong_passphrase_or_tampered" | ... }
  }
};
```

In the page, check a new passphrase before you seal anything:

```ts
import { checkNewPassphrase } from "@gainratio/browser/seal";

const check = checkNewPassphrase(passphrase, confirmation);
if (!check.ok) showError(check.reason); // "empty" | "too_short" | "mismatch"
```

Importing `@gainratio/browser/seal` is cheap. `age-encryption` (about 53 KB gzipped) is
loaded on the first seal or open, and the main `@gainratio/browser` entry never loads it.

## API

| Function | Returns |
| --- | --- |
| `checkNewPassphrase(pass, confirm, { minLength? })` | `{ ok: true }` or `{ ok: false, reason: "empty" \| "too_short" \| "mismatch" }`. Default minimum 12 |
| `sealWithPassphrase(bytes, pass, { workFactor? })` | `{ ok: true, bytes }` (an age v1 file) or `{ ok: false, reason: "empty_passphrase" \| "invalid_work_factor" }` |
| `openWithPassphrase(bytes, pass, { maxWorkFactor? })` | `{ ok: true, bytes }` or `{ ok: false, reason }`, where reason is `wrong_passphrase_or_tampered`, `not_sealed`, `malformed`, `unsupported` (an age file for a public key) or `too_costly` |
| `isSealed(bytes)` | `true` for a binary or ASCII-armored age file. Does not check anything else |
| `openLegacyPbkdf2AesGcm(bytesOrText, pass)` | `{ ok: true, bytes, format }` or `{ ok: false, reason }`. Read-only; see below |

A wrong passphrase and a changed file give the same reason on purpose: the crypto cannot tell
them apart, and guessing would mislead the user.

## Choices, and why

- **Work factor 17 (scrypt N = 2^17, r = 8, p = 1, 128 MiB).** That is the OWASP Password
  Storage floor for scrypt. The age CLI uses 18 (256 MiB); we stay one step lower because the
  phones that run out of memory are the ones we most need to work. Pass `workFactor` (10 to
  20) to change it. Below 16 is for tests only.
- **Opening refuses work factors above 18 by default** (`too_costly`), before any scrypt runs,
  so a hostile file cannot make a phone allocate 1 GiB. 18 opens what the Go `age` CLI writes.
  `rage` picks its work factor by timing the machine and wrote 20 on an M-series Mac; pass
  `maxWorkFactor: 20` to open such files.
- **Passphrases are sealed in Unicode NFC form.** The same visible text can arrive as
  different code points: "é" is one code point from most keyboards and two from some input
  methods. Without normalizing, a backup made on one device could refuse the right passphrase
  on another. Open tries NFC first, then the text exactly as typed, so a file sealed by
  another age tool with a non-NFC passphrase still opens.
- **Whitespace is kept.** A space is a legal passphrase character, and trimming would silently
  change the secret. The one exception: a passphrase of only whitespace counts as `empty`.
- **Length is counted in code points after NFC**, as NIST SP 800-63B asks, so an emoji is
  one character and a decomposed "é" is one character.

## Old files: `openLegacyPbkdf2AesGcm`

This opens, and never writes, the files our apps produced before 0.4.0:

| `format` | Written by | Notes |
| --- | --- | --- |
| `almamesh-portable-v3` | almamesh `portableBundle.ts` | 64-byte binary header (magic `ALMAMESH`), header authenticated. 64 MiB cap (`too_large`) |
| `almamesh-backup-v2` | almamesh, older | JSON; header fields authenticated |
| `almamesh-backup-v1` | almamesh `backupCrypto.ts` | JSON; 210,000 iterations; no authenticated header |
| `amlfilter-install-key-v1` | aml-filter `installKeyExport.ts` | JSON; header authenticated. The app still checks the decrypted key against `public_key_hex` |

Every format uses the iteration count stored in the file, and only if it is between 100,000
and 10,000,000. Below that is a downgrade; above it would burn the CPU. Outside the range the
result is `unsupported`, before any key is derived. The passphrase is tried as typed, then in
NFC and NFD, because these writers never normalized.

The bytes come back exactly as the app encrypted them (the SQLite file, the JSON of the stores,
or the 32-byte seed). Parsing them is the app's job.

The tests open golden files made by the current almamesh and aml-filter code. To regenerate
them (they are reproducible byte for byte):

```bash
ALMAMESH_DIR=../almamesh AMLFILTER_DIR=../aml-filter node scripts/generate-legacy-seal-fixtures.mjs
```

## Measured

5 MiB payload, default work factor 17, in a dedicated Worker, headless Playwright on an Apple
M-series Mac (`test/browser/seal.spec.ts` prints these):

| Engine | Seal | Open |
| --- | ---: | ---: |
| Chromium | 473 ms | 328 ms |
| Firefox | 456 ms | 428 ms |
| WebKit | 317 ms | 299 ms |

Not measured: a real iPhone or a low-end Android phone. Measure there before raising the
work factor.

## What it does not do

- **No public-key recipients.** Only passphrase files. An age file sealed to a key reports
  `unsupported`.
- **No streaming.** Seal and open take and return whole `Uint8Array`s.
- **No passphrase strength scoring.** `checkNewPassphrase` checks length and confirmation only.
