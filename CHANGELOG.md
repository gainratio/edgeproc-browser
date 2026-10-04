# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-04

The first npm release since 0.1.1. If you were installing this package from a git
commit to get these features, you can now install it from npm instead.

### Moving off the git-sha alias

Some apps pinned `"@edgeproc/browser": "github:hseshadr/edgeproc-browser#<sha>"` (or the
same git URL under the `@gainratio/browser` name) to get the fixes below before they were
released. Replace that line with `"@gainratio/browser": "^0.2.0"` and change imports from
`@edgeproc/browser` to `@gainratio/browser`, subpaths included (`@edgeproc/browser/sqlite`
becomes `@gainratio/browser/sqlite`). Nothing else changes: the npm tarball is the same
committed `dist/` the git install gave you, now with provenance. `@edgeproc/browser` gets no
new versions.

### Added

- **New subpath `@gainratio/browser/sql`: a typed SQL seam.** `openSqlDatabase({ name })` opens a named
  SQLite database in the library's Worker, on OPFS (`opfs-sahpool`, owner-locked), with the
  memory profile applied and FTS5, JSON1 and sqlite-vector on one connection. Typed `exec`,
  `query`, `transaction`, `executeMany` and prepared statements. An in-memory fallback is
  opt-in and reported in `db.storage`. `removeSqlDatabase` / `removeOpfsPool` delete old
  pools idempotently. Consumers no longer load `sqlite3.mjs` by path. See docs/sql.md.
- **SQLite export/import in `@gainratio/browser/sql`.** `exportDatabase(db | name)` returns
  the database as a SQLite file (`sqlite3_serialize`). `importDatabase(db | name, bytes,
  { expectedSchema })` checks the header, `integrity_check`, `application_id`,
  `user_version` and your read-only checks in a scratch connection, then swaps the data in
  one transaction; any failure leaves the old database intact. By name it runs under the
  owner Web Lock. The file's schema text is treated as untrusted: one plain CREATE per row,
  triggers/views only with `allowTriggersAndViews`, virtual tables only from
  `virtualTableModules` (default fts5), `trusted_schema = OFF` afterwards. See docs/sql.md.
- CI rebuilds `dist/` from empty and fails if it differs from the committed build.
- **SQLite memory profile.** A `memoryProfile` option (`"auto"` by default, or `"full"`,
  `"lite"`, `"minimal"`) sizes SQLite's page cache, heap limits, `temp_store` and
  `mmap_size` to the device, so persistent indexes on OPFS stay small on phones instead of
  running out of wasm memory on iPhone Safari. It applies to the vector index, the state
  store and the SQL seam. The PRAGMAs are read back after open, and open fails if SQLite
  ignored one. `detectMemoryTier()` shows what `"auto"` would pick. See
  docs/memory-profile.md.

### Fixed

- **A second tab no longer fails to open the SQLite state store.** SQLite's
  `opfs-wl` VFS let two tabs hold a shared read lock at once, but Chromium
  allows only one OPFS sync access handle per file. While one tab was busy, the
  other logged `GetSyncHandleError ... NoModificationAllowedError` and got
  `SQLITE_BUSY` (`database is locked`) on open or on a read. Every state-store
  operation, including open and close, now runs inside the store's exclusive
  Web Lock, so tabs take turns. Reads in two tabs are now serialized rather
  than concurrent. A Playwright test drives two real tabs against one store.

## [0.1.1] - 2026-10-01

0.1.0 was published by hand from an earlier `main` and has no entry of its own;
the entries below cover everything on `main` up to 0.1.1.

### Changed

- **Renamed to `@gainratio/browser`; old name deprecated.** New releases ship
  only as `@gainratio/browser`, published by CI with npm provenance.
  `@edgeproc/browser` 0.1.0 keeps installing. Change
  `npm install @edgeproc/browser` to `npm install @gainratio/browser` and update
  imports, including subpaths such as `@gainratio/browser/worker`.

- **Warm boot is about 2.4x faster, and still re-verifies every byte.** A reload
  used to read, decompress and hash each cached chunk one at a time, then read
  them all again when the app loaded the files. Profiling in real Chromium showed
  the hashing was never the cost (about 25 ms of 430 ms for the 552-chunk
  almamesh bundle): the cost was one exclusive OPFS sync access handle per chunk,
  which Chromium creates one at a time. Chunk reads and presence probes now use
  the lock-free `getFile()` snapshot, and sync reads up to 8 chunks at once
  (`MAX_CONCURRENT_CHUNK_READS`). Every chunk is still decompressed and checked
  against its content address, and every file against its signed hash, on every
  boot. A cached chunk rewritten at rest is refused and re-fetched; a real-OPFS
  test proves it. Local Chromium, almamesh bundle: warm sync 428 ms to 173 ms,
  reading all 8 files 258 ms to 103 ms (medians).

### Fixed

- **A slow mobile link no longer kills the sync.** On a slow-4G connection
  (about 180 KB/s) the cold sync of an 18 MB bundle tripped the client's 60 s
  idle deadline on every attempt, so the app never started. Two things were
  wrong. The transport had a 15 s wall clock per request that started at
  `fetch()` and covered connection queueing plus the whole body, so a chunk that
  was merely slow was aborted and silently retried; and progress was reported
  only when a whole chunk had been fetched, verified and stored, so the idle
  deadline (re-armed by progress) heard nothing while fetches sat in retry.
  Now `fetchBytes` has a stall window instead of a wall clock
  (`FETCH_STALL_TIMEOUT_MS`, 30 s with no bytes; re-armed on every network
  read and on headers), a transfer that keeps moving is never cut off, each
  stall is retried with the existing bounded backoff and reported as a
  `chunkRetry` progress event, and `chunks` progress moves on every network
  read (rate-limited to 4/s). Chunks already verified and stored are never
  re-downloaded: a sync that fails mid-way resumes from the cache. A real-
  Chromium test holds every chunk request for 75 s mid-sync (longer than the
  idle deadline) and proves the sync survives, names the stall, and re-fetches
  only the chunks that were in flight. Security is unchanged: every chunk is
  still hash-verified before it is stored or served. One side effect: on a
  black-hole network (no error, no bytes) an offline warm boot now waits 30 s
  before serving the cache, where it used to wait 15 s. `FETCH_TIMEOUT_MS` is
  gone; the equivalent export is `FETCH_STALL_TIMEOUT_MS`.


### Added

- **Progress an app can draw.** The `chunks` progress event carries
  `bytesTotal` (the uncompressed size of everything this sync fetches, exact,
  from the signed manifest) and `bytesDone` (completed chunks plus the received
  fraction of in-flight ones), so a consumer can show a real bar instead of a
  spinner. Two new phases: `chunkRetry` (a chunk fetch failed or stalled and is
  being retried after `delayMs`, with the `reason`) and `verify` (per file, while
  the reassembled files are checked against their signed hashes). The transport
  takes an `onBytes(received, total)` callback.

- **A portable SQLite application-state Lego.** The opt-in
  `@edgeproc/browser/sqlite` export provides namespaced byte rows, bounded
  listing, atomic batches with epoch CAS, transactional schema migrations,
  integrity checks, real SQLite byte export, staged validated import with
  transactional table replacement, reset, and runtime facts without exposing
  arbitrary SQL. It reuses the pinned SQLite 3.53.4 Worker runtime and its
  official `opfs-wl` VFS for Web-Lock-coordinated multi-tab access, while the
  existing vector adapter keeps its single-owner SAH pool. Real Chromium proves
  cross-Worker visibility, stale-CAS rejection, persistence,
  export/import, and zero external requests.

- **A shared browser-engine contract for multiple consumers.** Signed sync now
  supports exact nullable identity pins, whole-file and safe directory-prefix
  scopes (`[]` is catalog-only; `undefined` is all files), per-verified-chunk
  progress, progress-rearmed idle timeouts, typed Worker errors, and an explicit
  locked cache clear. Persistent storage uses OPFS as the sole content store
  with a tiny IndexedDB pointer floor, falls back to full IndexedDB when OPFS is
  unavailable, and can declaratively reuse a bounded legacy database/store/key
  layout. A real Vite fixture proves the supported consumer-owned Worker entry
  emits exactly one engine Worker. Direct browser ESM users can opt into
  `spawnEngineClient()` through the separate `@edgeproc/browser/spawn` subpath,
  keeping the root client export free of dependency-internal Worker URLs.

- **`PackedVectorIndex` for immutable signed-bundle matrices.** The
  dependency-free synchronous adapter copies and validates FLOAT32 input,
  computes exact cosine similarity with deterministic ties, exposes defensive
  row copies, and fails closed after zeroizing disposal.

- **Reproducible exact-Git-SHA installs across npm, pnpm, and Bun.**
  Deterministic `dist/` output is committed for clients that skip Git-package
  lifecycle scripts; `prepare` still rebuilds it where supported, and the gate
  rejects any source/artifact drift. Registry packages remain limited to
  `dist/`. Native Node ESM loading of every side-effect-free public export is a
  distribution contract, including explicit `.js` vector imports.

- **A replaceable browser vector contract and opt-in SQLite/OPFS adapter.** The
  dependency-free `FlatVectorIndex` and the Worker-hosted SQLite adapter share
  one conformance suite. The persistent adapter statically links only SQLite
  3.53.4 and Apache-2.0 sqlite-vector 1.1.2—no FAISS and no SQLiteAI
  sync/memory/network bundle—uses exact FLOAT32 cosine search, transactional
  batches, parameterized AND filters, deterministic ID tie breaks, and explicit
  disposal. Pinned artifact hashes, a digest-pinned Docker rebuild, and packaged
  third-party notices make the WASM auditable. A real Chromium test proves OPFS
  persistence across Worker restart and zero external requests.

- **A publish preflight that makes a stale `dist/` unpublishable.**
  `prepublishOnly` now runs `scripts/preflight-publish.mjs` and then the full
  gate. The script refuses outright — before anything is built or packed — if the
  tree is dirty, if `HEAD` is neither on a remote-tracking branch nor at an exact
  local tag published unchanged to `origin`, or if there is no git work tree at
  all; then it deletes `dist/` so the gate's build cannot reuse a stale object.
  This covers both normal branch builds and GitHub Actions' shallow detached-tag
  checkout without trusting a local-only or moved tag. `files: ["dist"]` means
  the tarball *is* `dist/`, which is
  gitignored, so previously `npm publish` shipped whatever the last build left on
  disk. It nearly shipped exactly that: `dist/engine/client.js` was rebuilt three
  minutes after `#releaseWorker()` landed and two days after the only commit on
  `main`, so the compiled output carried a fix no published commit contained.
  Covered by `test/publish-preflight.test.ts`, which drives every refusal and the
  accept case against real throwaway repos.

### Security

- **Key rotation, revocation, and pointer expiry.** The trust-root URL may now
  serve a strict `edgeproc.keyring/v1` JSON keyring
  (`{"schema","keys":[{"key_id","public_key"}],"revoked"}`, bounded to 64 KiB
  before parsing, unknown fields rejected, each `key_id` checked against
  sha256 of its key) instead of a raw key; exactly 32 bytes is still read as
  the legacy single key, so existing deployments are unchanged. The
  `VersionPointer` gains two OPTIONAL signed fields, folded into the preimage
  only when present so every existing pointer keeps its exact signed bytes:
  `key_id` (16 lowercase hex of sha256 of the signer's raw public key) selects
  the one key allowed to verify — revoked fails with `KeyRevokedError`,
  unlisted with `UnknownKeyError`, both `SignatureError`s — and without it any
  unrevoked key may verify while a revoked key never does (reported as
  `KeyRevokedError` while the revoked key is still listed). `expires_at` (Unix
  seconds, positive safe integer) makes a network-fetched pointer at or past
  its deadline fail with `PointerExpiredError` (an `IntegrityError`) after
  signature verification. Offline, an already-verified cached bundle whose
  pointer has expired is still served, with `expired: true` on the result, so
  offline PWAs keep working and can say so; a cached pointer signed by a
  since-revoked key is refused for serving but still acts as the rollback
  floor. `syncIndex` accepts either `verify` (unchanged) or `keyring`, plus an
  injectable `now()` clock. Every new error maps to the existing `integrity`
  Worker error code; no storage key or format changes, and durable records
  without the new fields load as before. Cross-runtime vectors generated from
  fixed seeds (`src/engine/__fixtures__/keyring_vectors.json`,
  `scripts/generate-keyring-vectors.mjs`) pin the key ids, preimages,
  signatures, and verdicts shared with edge-proc.

- **The anti-rollback floor now survives a key change.** `syncIndex` used to
  re-verify the durable active pointer under the currently pinned key and, on a
  `SignatureError`, clear it and treat the client as never having synced. Any
  key change — a planned rotation or a swapped pinned key — therefore reset the
  floor, and the next pointer, including an OLD release re-signed by the new
  key, was promoted with no freshness comparison. The stored pointer is now the
  floor whether or not the current key can verify it (it only ever refuses,
  never grants trust); serving the cached bundle offline still requires a
  signature valid under the current key, so an unverifiable cache fails closed
  instead of being served. This matches edge-proc's `cas.py`, which never
  re-verifies its stored pointer. No storage key or format change. Rotations
  must keep `sequence` increasing; a corrupted durable counter can only cause a
  `RollbackError`, recovered by an explicit cache clear.

### Fixed

- **Transient chunk outages no longer abort a cold sync immediately.** Only
  `NetworkError` receives six attempts with exponential jitter and a hard
  9-second backoff ceiling. Integrity, signature, storage, and rollback
  failures remain fail-closed with no retry.

- **The README now follows the portfolio template.** It has a plain-language first screen, an
  "At a glance" summary, and a 14-line tamper example whose output is pasted from a real run.
  All earlier content moved below the fold. The `package.json` description is now the
  tagline, and `test/readme.contract.test.ts` pins the first screen, the architecture-map
  link, and every relative link. The previous README's demo transcript also left out the
  `bytes fetched` line that `pnpm demo` prints.

- **CONTRIBUTING claimed things that were not true of this package.** It said
  coverage was enforced at 100% (`vitest.config.ts` enforces 90/90/90/85) because
  "the library is pure logic with no I/O" (its subject is OPFS, Workers and
  BroadcastChannel); it said the package has zero runtime dependencies (it has
  three); it told you to `cd errors` after cloning; and it listed the gate's steps
  in the wrong order, hiding that the build runs before the tests on purpose.

## Planned 0.1.0 (not yet published)

This is the planned first release; npm and GitHub do not yet carry a 0.1.0
package, tag, or release. The signed-bundle sync substrate of edge-proc was extracted from
[edge-reco](https://github.com/hseshadr/edge-reco) — where it had been running in
production — so its three consumers can stop each carrying their own copy after
publication.

### Added

- **Verification core** — `verifyEd25519`, `sha256Hex` (`SignatureError`);
  `canonicalBytes` for the exact bytes a signature is taken over;
  `decompressAndVerify` / `verifyPlaintext` with a bounded expansion limit
  (`IntegrityError`); `decompressBounded` over `@hpcc-js/wasm-zstd`.
- **Sync state machine** — `syncIndex` and `materializeFile`, with monotonic
  pointer enforcement (`RollbackError` on a lower or equal-sequence pointer,
  rejected *before* the manifest fetch) and structural caps (`SyncCapError`).
- **Transport** — `fetchBytes`, byte-capped while streaming and bounded by a 15s
  deadline that includes body consumption. An oversized response raises
  `ResponseTooLargeError`, which extends `IntegrityError` rather than
  `NetworkError`, so sync can never silently serve cache for one.
- **Stores** — `MemoryCacheStore` and `OpfsCacheStore`, both content-addressed
  and fail-closed on read as well as write.
- **Worker boundary** — `EngineClient` plus typed failures `WorkerCrashError` and
  `WorkerTimeoutError`. A Worker that dies during init never posts a reply; without
  these, every in-flight promise hangs forever.
- **`installNetworkSentinel`** — the module this package exists to share. Each
  browsing context keeps its own resource-timing timeline, so a window-side
  `PerformanceObserver` cannot see anything a Worker fetches. The sentinel observes
  a Worker's own timeline and broadcasts it on a same-origin `BroadcastChannel`,
  carrying EPOCH timestamps (the one clock every context shares) so a reader can
  rebase them. `isNetworkSentinelReport` validates shape before counting, because
  same-origin is not the same as trusted. It degrades to a no-op rather than
  throwing where `PerformanceObserver` or `BroadcastChannel` is missing.
- `test/dist-contract.test.ts`, which asserts against **real build output** that
  the opt-in `spawnEngineClient()` names a Worker file that exists, that the
  root client contains no Worker URL, that every `exports` path resolves, and
  that nothing shipped imports `node:*`.
- `test/workflow-security.test.ts`, which fails the gate on any unpinned `uses:`
  or top-level write scope, and carries accept/reject cases so the rule itself is
  proven rather than assumed.

### Changed from the extracted source

- Relative import specifiers gained `.js` extensions for spec-correct ESM.
- The consumer-independent persistence, scoped-sync, progress, typed-error,
  locked-clear, and packed-vector contracts now live here instead of remaining
  vendored in product repositories.
- Worker spawning moved out of `EngineClient` and into the opt-in
  `@edgeproc/browser/spawn` subpath. The supported Vite path remains a
  consumer-owned one-line Worker entry importing `@edgeproc/browser/worker`.

### Known gaps

- `opfsStore.ts` remains excluded from the numeric jsdom coverage gate because
  jsdom has no OPFS implementation. An in-memory OPFS double covers dual-slot
  promotion, corrupt/zero-byte cleanup, and pre-write handle contention; the
  Chromium tier proves real OPFS persistence.
- The first `0.1.0` publish would carry **no npm provenance**. npm has no
  "pending publisher" state — a trusted publisher attaches to an existing
  package — so the first publish of a new name must be manual, and a published
  version is immutable. If 0.1.0 is bootstrapped this way, the next release must
  be a provenance-bearing patch.

### Evidence

- Gate green: 32 test files, 284 tests. Coverage 92.87% statements / 86.32%
  branches / 96.84% functions / 93.73% lines. The real Chromium SQLite/OPFS
  vector and multi-Worker state persistence tests also pass.
- The `networkSentinel` guard was watched failing, not merely watched passing.
  Four mutations, each verified applied by md5 before its result was trusted and
  each judged on the vitest **exit code** rather than grepped output: dropping the
  `timeOrigin` rebase (3 failures), making `isNetworkSentinelReport` return `true`
  unconditionally (1), accepting entries of any field type (1), and observing
  without `buffered: true` (1). All four went red; the unmutated control was green;
  the file was restored byte-identical.
