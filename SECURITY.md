# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for a security problem.

Report it privately in one of two ways:

1. GitHub's private reporting — go to the
   [Security tab](https://github.com/gainratio/edgeproc-browser/security/advisories/new)
   and open a draft advisory. This is preferred; it keeps the discussion in the
   repo and lets us issue a CVE if one is warranted.
2. Email `harish.seshadri@gmail.com` with `SECURITY` in the subject.

Please include what you can: the version, a description of the problem, and the
smallest input that reproduces it.

We aim to acknowledge a report within 5 working days and to ship a fix or an
explanation of why it is not a vulnerability within 30 days.

## Supported versions

This project is pre-1.0. Only the latest published version gets fixes. Once 1.0
ships, the latest minor of the current major will be supported as well.

## Threat model

`@gainratio/browser` deliberately performs network and browser-storage I/O. Its
security boundary is a signed, monotonic pointer: the Worker fetches a pinned
trust root (a public key or a keyring) without HTTP-cache reuse, verifies the
pointer, content-addresses the
manifest, bounds compressed and expanded bytes, verifies every chunk and
reassembled file, then promotes last. Invalid bytes never become a degraded
result.

Important integration rules:

- Pin the expected bundle and channel when the publisher has those identities.
  `undefined` deliberately skips a pin; `null` requires a legacy absent/null
  field exactly.
- Treat the configured public-key URL as a trust root. Serve it over HTTPS and
  control it separately from mutable bundle content.
- Cache names and legacy (0.2.x) IndexedDB layouts are local identifiers, not
  secrets. Layout input is bounded and cannot select arbitrary code or callbacks.
  The layout is only read once, to migrate a 0.2.x cache; the library never
  writes to IndexedDB.
- The SQLite chunk database on OPFS (chunks, manifests, the active pointer and
  the rollback floor) is untrusted durable state. Every chunk is re-hashed on
  read and a bad row is deleted; equal-sequence disagreement fails closed. A
  trigger refuses any update that lowers the floor.
- Migrated 0.2.x content is checked by content address before it is copied, and
  the migrated floor is the highest legacy sequence, never lower.
- When OPFS is refused, the cache is an in-memory SQLite database and the
  rollback floor lasts only for that Worker's life. Sync results report this as
  `cacheBackend: "sqlite-memory"`.
- The stored active pointer is the anti-rollback floor even when the currently
  pinned key cannot verify it (after a key rotation, or a swapped key), so a key
  change never resets the floor: an older release re-signed by a new key is
  refused as a rollback. The floor only refuses; the cached bundle is served
  offline only under a signature the current trust root verifies. A key
  rotation must therefore keep the publisher's `sequence` increasing.

### Trust root, rotation, revocation, and expiry

- **Trust root forms.** The configured URL serves either exactly 32 bytes (the
  legacy raw Ed25519 key, a keyring of one) or a strict
  `edgeproc.keyring/v1` JSON keyring. The keyring is size-capped (64 KiB)
  before decoding, rejects unknown fields, duplicate ids, malformed hex, and
  any `key_id` that is not the first 16 hex chars of sha256 of its key, and
  must leave at least one key unrevoked. A malformed trust root verifies
  nothing (`KeyringError`). It is fetched `no-store`, same as before; whoever
  controls it controls trust, so host it apart from mutable bundle content.
- **Rotation.** Publish a keyring listing old key A and new key B, then sign
  new pointers with B and a `key_id` naming B at a higher `sequence`. Clients
  keep verifying A-signed caches while A is listed and unrevoked. Extending an
  `expires_at` or switching signer for the same release also needs a new
  `sequence`: the persistent stores refuse to promote a pointer that differs
  from the active one in any signed field at the same sequence.
- **Revocation.** Listing a key id in `revoked` makes every signature by that
  key fail: a pointer naming it fails with `KeyRevokedError`, and a pointer
  without `key_id` is only accepted under unrevoked keys (if it verifies only
  under a revoked key that the ring still lists, it fails with
  `KeyRevokedError`; if the revoked key is no longer listed, with
  `SignatureError`). A cached bundle whose
  pointer was signed by a now-revoked key is refused for offline serving
  (fail closed), yet that pointer remains the anti-rollback floor, so revoking
  a key never lets an older release back in.
- **Unknown signer.** A pointer whose `key_id` is not in the keyring fails
  with `UnknownKeyError`; there is no fallback to other keys.
- **Expiry (freeze/replay defense).** `expires_at` is signed Unix seconds. A
  network-fetched pointer is refused with `PointerExpiredError` once
  `now >= expires_at`, checked after its signature verifies. A publisher using
  expiry must re-sign (with a higher `sequence`) before the deadline, or every
  online client stops updating.
- **Offline-expired policy (deliberate).** When the origin is unreachable,
  sync serves the already-verified cached bundle even if its pointer has
  expired, and marks the result `expired: true`. Refusing would brick offline
  PWAs that hold intact, authentic bytes; the flag lets the application tell
  the user the data may be stale. Applications that must never show expired
  data should treat `expired: true` as a failure.
- **Clock.** Expiry uses the device clock (`Date.now() / 1000`) unless a
  `now()` is injected. A client whose clock runs slow can accept a pointer
  past its deadline; one running fast refuses early. Expiry bounds replay
  windows; it is not a secure time source.
- **Single-verifier callers.** Code that calls `syncIndex` with its own
  `verify` function keeps its behavior. `key_id` is covered by the signature
  but cannot select a key on that path; `expires_at` is still enforced.
### Other integration rules

- Worker error messages can include URLs or producer-controlled identifiers.
  Do not render them as HTML and do not place secrets in bundle paths or URLs.
- The network sentinel is evidence about requests, not an access-control
  mechanism. Same-origin channel messages are shape-checked but are not treated
  as authenticated actors.

Runtime dependencies are `@noble/ed25519`, `@hpcc-js/wasm-zstd` and, for the opt-in
`/seal` export only, `age-encryption`. The chunk
store and the optional SQLite subpaths share pinned local WASM assets and do not
load code from a CDN.
