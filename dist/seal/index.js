// @gainratio/browser/seal — passphrase file encryption.
//
// New files are standard age v1 files (scrypt), so `age -d` opens them with no
// code of ours. Old PBKDF2 + AES-GCM files from almamesh and aml-filter keep
// opening through `openLegacyPbkdf2AesGcm`, which never writes.
//
// scrypt is synchronous and holds 128 MiB at the default work factor: call
// `sealWithPassphrase` and `openWithPassphrase` from a Worker. Importing this
// entry is cheap; the age library loads on the first seal or open.
export { DEFAULT_MAX_OPEN_WORK_FACTOR, DEFAULT_SCRYPT_WORK_FACTOR, isSealed, MAX_SCRYPT_WORK_FACTOR, MIN_SCRYPT_WORK_FACTOR, openWithPassphrase, sealWithPassphrase, } from "./age.js";
export { LEGACY_MAX_ITERATIONS, LEGACY_MIN_ITERATIONS, openLegacyPbkdf2AesGcm, } from "./legacy.js";
export { checkNewPassphrase, DEFAULT_MIN_PASSPHRASE_LENGTH, normalizePassphrase, } from "./passphrase.js";
//# sourceMappingURL=index.js.map