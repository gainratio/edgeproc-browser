# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-10-05

Apps that require persistent storage can now refuse the engine's in-memory fallback.
Nothing changes unless you pass the new option.

### Added

- **`cacheFallback: "memory" | "none"`** on `EngineClient.sync`, `clear` and `readFile` (and
  on the `SyncRequest`, `ClearRequest` and `ReadFileRequest` protocol messages). The default
  `"memory"` keeps the 0.3.0 behavior. With `"none"`, when OPFS cannot be opened the engine
  Worker opens no in-memory cache, fetches nothing (not even the trust root), and rejects at
  once with the new `EngineStorageUnavailableError`. A Worker's first call fixes the value,
  so pass it to `readFile` too when that may be the first call.
- **`EngineStorageUnavailableError`**, a subclass of `EngineOperationError` with
  `code: "storage"` and a `reason`: `"opfs-unavailable"` or `"pool-in-use"`
  (`EngineStorageUnavailableReason`). Only `cacheFallback: "none"` refusals produce it.
- `EngineErrorDetail` gains an optional `reason`, set only on those refusals.
- `EngineCacheFallback` type export.

Nothing existing changes: every error the engine raised on 0.3.0, including its own
refusals in the default mode (a pool held by another context, a persisted cache that cannot
be reopened), keeps the same class, `code` and message.

## [0.3.0] - 2026-10-04

The chunk cache moves to one SQLite database per cache, on OPFS. This is a storage format
change. On the first session after upgrading, a 0.2.x cache is checked and migrated once;
anything that cannot be migrated is simply downloaded again. IndexedDB is no longer used.

This release also carries the 0.2.2 integrity hotfix, which was never published on its own.
Upgrade if you use `@gainratio/browser/sql` or `@gainratio/browser/vector/sqlite` with OPFS
storage.

### Breaking

- **New storage format.** The OPFS one-file-per-chunk store (origin-root `chunk/`,
  `manifest/`, `active`, `active.a`, `active.b`, `mutation.lock`) and the IndexedDB store and
  floor are gone. Chunks, manifests, the active pointer and the rollback floor now live in one
  SQLite database named `${cacheNamespace}-chunks`, opened through the library's SQL seam
  (`opfs-sahpool`, pool owner Web Lock, `MemoryProfile` limits, `secure_delete=ON`).
- **Removed exports:** `OpfsCacheStore`, `IndexedDbCacheStore`, `openPersistentCacheStore`,
  `PersistentCacheStore`, `PersistentStoreOptions`, `requestPersistentStorage`, and the
  `StoragePreference` type. `canPromotePointer` and `selectHighestPointer` are still exported.
- **Removed option:** `storageBackend` on `EngineClient.sync` and `clear`. There is no backend
  to choose.
- **Changed status values:** `cacheBackend` is now `"sqlite-opfs"` or `"sqlite-memory"`
  (`"opfs+indexeddb"` and `"indexeddb"` are gone).
- **`indexedDbLayout` changed meaning.** It now only says where a 0.2.x cache kept its
  IndexedDB floor and chunks, so they can be migrated once.
- **Runtime dependency removed:** `idb-keyval`.
- **`db.close()` rolls back an open interactive transaction instead of waiting for it.** This
  reverses a contract: `close()` used to wait for the transaction to finish, so a callback
  that awaited `db` inside its own transaction hung `close()` forever. Now the transaction is
  rolled back, calls queued behind it reject, and the Worker ends. Commit before closing.

### Added

- `SqliteCacheStore`, `ChunkSqlConnection`, `pointerIdentity`, `ChunkDatabase`,
  `ChunkDatabaseOptions`, `chunkDatabaseName`, `migrateLegacyStores`, `LegacySource`,
  `LegacySnapshot` and `MigrationReport`. `resolveIndexedDbLayout`, `IndexedDbLayout` and
  `IndexedDbLayoutOptions` stay, now from the migration reader.
- **`result.cacheStorage`** on every sync: `{ persistence: "opfs", pool, file }`, or
  `{ persistence: "memory", reason: "opfs-unavailable" | "pool-in-use", detail }`.
- **Tabs take turns on one file.** The engine Worker holds storage only for a session (cache
  Web Lock, then pool owner lock, run the queued work, release), opening a fresh connection
  each time. Two tabs syncing and reading at once both persist to OPFS and share chunks.
- **One-time migration** from the 0.2.x OPFS and IndexedDB stores. Every chunk is checked by
  content address and copied in one transaction; the floor is never lowered. It is
  crash-resumable and idempotent. On failure it warns, deletes nothing, and retries next
  session. Only the library's own IndexedDB keys are deleted.
- **In-memory fallback.** If OPFS is refused or another context holds the pool past 5 s, the
  Worker uses one in-memory SQLite database for its life and re-downloads each session.
- **Interactive SQL transactions.** `db.transaction(async (tx) => { … })` runs
  `BEGIN IMMEDIATE`, your callback's `tx.query` / `tx.exec`, then `COMMIT`; a throw or a failed
  `COMMIT` rolls back and rejects with that error. The handle holds its connection lock for the
  callback, so other calls on it (including other transactions) wait instead of interleaving.
  The statement-list form is unchanged. `tx` refuses BEGIN/COMMIT/ROLLBACK/SAVEPOINT (an SQLite
  authorizer), and once SQLite itself ends the transaction (`RAISE(ROLLBACK)`, `SQLITE_FULL`,
  `IOERR`, `BUSY`) every later `tx` call and the `COMMIT` reject with the new
  `SqlTransactionEndedError`, so nothing is written in autocommit.
- **`migrateLegacySahPool({ fromPool, fromFile, to })`** (and `db.migrateLegacySahPool`): move
  a database another SQLite build kept in an opfs-sahpool into one this library owns. Holds a
  Web Lock and the old pool's access handles (an old-build tab that has it open gives
  `"in-use"`), lets SQLite roll back a hot journal the old build crashed with, imports through
  the normal validated, atomic import, and removes the old pool only with `removeLegacy: true`
  and only when it holds nothing but that database and its journal (`legacy: "shared"`
  otherwise: removing a sahpool deletes every file in it).
- **`@gainratio/browser/sql/node`**: `openNodeSqlDatabase({ name })` runs the same pinned SQLite
  build, client and handler in-process, so consumers' SQL tests run against the real engine.
- **A connection opened while an import or export by name runs now waits for it.** The by-name
  operation holds a `${pool}-operation` Web Lock; a context whose owner-lock wait runs out while
  it is held waits for the operation to finish, up to 15 owner-lock budgets (60 s on `full`),
  instead of failing `pool-in-use` at once (seen in CI when a 4 MB import outlasted the 1 s
  wait). An operation that never ends still yields the typed `pool-in-use`, not a hang.
- Docs: importing a schema that has triggers (`allowTriggersAndViews: true`), with the
  workstation's append-only pair as the example.

### Changed

- **The SQLite runtime is now built with Emscripten 6.0.11** (was 4.0.15). Same SQLite 3.53.4
  and sqlite-vector 1.1.2; `sqlite3.wasm` is 932,259 bytes (was 934,257). Vector and FTS5
  query speed is unchanged in Chromium and WebKit. WASM SIMD was measured and left off:
  sqlite-vector has no wasm SIMD kernels, and autovectorised scalar code was 5-20% slower.
- `removeOpfsPool` / `removeSqlDatabase` can return a new `"timeout"`: the wait for the owner
  lock ended but no owner could be confirmed. `"in-use"` now means a live owner is confirmed.
  Callers that switch exhaustively on the result need the new case.
- **The owner-lock wait (open and removal) is longer and scales with the memory tier:** 4 s
  `full`, 8 s `lite`, 16 s `minimal`. 0.2.1 waited a fixed 2 s; unreleased `main` briefly
  had 1 s / 2 s / 4 s by tier. A writer that met an import on a
  2-core CI runner gave up after 1 s; weak phones are slower still. Override per call with
  `lockWaitMs`.

### Fixed

- **A crash in the middle of a write transaction could leave a half-written database.**
  Affected: OPFS databases opened through `/sql` (`openSqlDatabase`) and the persistent
  `/vector/sqlite` index, both of which use SQLite's `opfs-sahpool` VFS with the rollback
  journal (`journal_mode=DELETE`). In the pinned SQLite 3.53.4 that VFS always told the pager
  some connection held a RESERVED lock, so the pager never treated a leftover journal as hot
  and never rolled it back. If the Worker died mid-transaction (tab closed or crashed, the
  Worker terminated, the device killed the page) after the pager had spilled pages to the
  database file, the next open read a mix of old and new pages. `PRAGMA integrity_check`
  often still said `ok`; the damage showed up as wrong data, or as `SQLITE_CORRUPT`. In
  Chromium a Worker killed with an open transaction came back torn in 20 of 20 rounds.
  Not affected: `@gainratio/browser/sqlite` on `opfs-wl`, and memory-only databases.
  The fix is SQLite's own: check-in
  [ea1d55e202e6e](https://sqlite.org/src/info/ea1d55e202e6e) (branch-3.53; trunk
  [9168a6f1be](https://sqlite.org/src/info/9168a6f1be), forum report
  [b2fbb61642](https://sqlite.org/forum/forumpost/b2fbb61642)), backported verbatim as local
  patch `0002` because no 3.53.x release carries it yet. SQLite, sqlite-vector and emsdk are
  unchanged.
  **What upgrading does:** a hot journal left by a crash is rolled back on the next open, so
  an interrupted transaction disappears as a whole. **What it cannot do:** a database that was
  already torn before the upgrade has no journal left to replay, and `integrity_check` cannot
  tell you. If a crash could have hit a write on 0.2.1 or earlier, check your own invariants
  (counts, sums, cross-table references) or rebuild the data from its source.
- **Removing a pool right after closing it could report `"in-use"` and leave it on disk.**
  `index.dispose()` resolved once SQLite closed the database, but the vector Worker kept the
  pool's OPFS sync access handles open until the browser tore the Worker down, so
  `removeOpfsPool` straight after `dispose()` failed in 34 of 50 rounds in Chromium. Apps that
  delete an old pool on every boot (edge-reco) kept it. The vector Worker now holds the pool's
  owner Web Lock like `openSqlDatabase` does, and `dispose()` and `db.close()` resolve only
  after the handles are closed and the lock is free. `removeOpfsPool` and `removeSqlDatabase`
  take that lock with a bounded wait and delete while holding it. No retries or sleeps.
- **Opening an OPFS vector index another tab owns threw a plain `Error`.** It is now
  `SqlStorageUnavailableError("pool-in-use")`, the same type `openSqlDatabase` uses.
- **Two connections on one OPFS database in the same Worker could both write.** The pinned
  3.53.4 `opfs-sahpool` VFS let every `xLock` succeed. Backported SQLite check-in
  [9e2caaa382](https://sqlite.org/src/info/9e2caaa382) as local patch `0003`: a per-path lock
  table, so the second writer gets `SQLITE_BUSY`.
- **The `opfs-sahpool` busy handler could freeze its thread.** It inherited the default VFS's
  `xSleep`, which cannot free a lock held in the same thread. Backported
  [c9dd4d88e4](https://sqlite.org/src/info/c9dd4d88e4) as local patch `0004`: `xSleep` is a
  no-op, so a `busy_timeout` fails fast instead of blocking for its full length.

### Security

- **A release can no longer publish from red CI.** 0.2.1 was published from a commit whose
  CI on main had failed, because pushing a `v*` tag was the whole trigger. `publish.yml` now
  runs `scripts/verify-release-tag.mjs` first, and the OIDC publish job depends on it. It
  fails closed unless the tag is `v` + package.json's version, the commit is on main, and the
  newest `ci.yml` push run for that commit concluded success. The publish job now runs in the
  `npm-release` environment. The gate alone stops mistakes; a tag on an unreviewed commit can
  edit the workflow, so the tag ruleset and protected environment in repo settings are what
  stop that.
- The rollback floor shares a row with the pointer, and a SQLite trigger refuses any update
  that lowers it. `promote()` is one `BEGIN IMMEDIATE` transaction that refuses if any needed
  chunk is missing, so no pointer can name a missing chunk.
- Every read still re-hashes the chunk and fails closed; a bad row is deleted and re-fetched.
  A BLOB tampered through SQL is refused (proved in a real browser).
- `storageGuard.test.ts` fails if any shipped module except the migration reader touches
  IndexedDB or Web Storage, or if that reader ever writes.
- **Three more paths around the rollback floor fail closed.** A chunk database that exists on
  disk but whose OPFS open fails for a reason other than contention no longer falls back to an
  empty in-memory floor. A 0.2.x floor that was read but could not be written (BUSY, I/O)
  refuses like an unreadable one instead of being skipped. An unreadable legacy `active`
  pointer is refused even beside a valid `active.a`/`active.b`.

### Known limitations

- In memory mode (Safari private mode, Playwright WebKit) the rollback floor lasts only for
  that Worker's life, and every session downloads again.

### Consumer migration

Remove the `storageBackend` option:

```ts
// before (0.2.x)
await client.sync(bundleUrl, keyUrl, { storageBackend: "indexeddb" });
// after (0.3.0)
await client.sync(bundleUrl, keyUrl);
```

Tell users when the cache will not persist:

```ts
// before (0.2.x)
if (result.cacheBackend === "indexeddb") { /* ... */ }
// after (0.3.0)
if (result.cacheStorage.persistence === "memory") {
  console.warn("cache is in memory:", result.cacheStorage.reason);
}
```

Swap direct store imports:

```ts
// before (0.2.x)
import { OpfsCacheStore } from "@gainratio/browser";
// after (0.3.0)
import { SqliteCacheStore } from "@gainratio/browser";
```

Keep `indexedDbLayout` only if you passed it before, so your old cache is found and migrated.
If you never set it, do nothing.

## [0.2.1] - 2026-10-04

Hardens SQLite import, makes a refused OPFS root a typed error, and adds Firefox and WebKit
to CI. No API changes; one new `RangeError` for a bad `maxBytes`.

### Fixed

- **A crafted backup could break the live connection.** A file whose `STORED` generated
  column calls one of your app's SQL functions passed validation (the scratch connection
  does not have your functions), then failed to load on the live connection with a raw
  `SQLITE_CORRUPT`. The scratch schema could not be detached, so every later statement on
  that connection failed too. The import now loads the file's schema before changing anything,
  refuses it as `SqlImportRejectedError("corrupt")`, and always detaches the scratch schema
  (with `writable_schema` on for that one `DETACH`), so the connection keeps working.
- **`maxBytes: NaN` turned the import size limit off** (`n > NaN` is always false).
  `maxBytes` must now be a positive integer; `NaN`, `Infinity`, `0`, a negative or a
  fractional value throws `RangeError`.
- **`removeSqlDatabase` / `removeOpfsPool` threw a bare DOMException when the browser
  refuses the OPFS root** (Playwright's WebKit: `UnknownError`). They now throw
  `SqlStorageUnavailableError("opfs-unavailable")`, the same typed reason `openSqlDatabase`
  reports.

### Tests

- A behavioural test for `trusted_schema = OFF`: an imported trigger or view that calls an
  app-defined function does not run it.
- `test/browser/cross-browser.spec.ts` runs in Chromium, Firefox and WebKit: OPFS open (or,
  in Playwright's WebKit, the typed `opfs-unavailable` memory fallback), a SQL round trip
  with FTS5, export/import, and memory-profile detection without `navigator.deviceMemory`.
  CI installs all three engines.
- The test server now always answers 200: Vite's `304 Not Modified` dropped the COEP/COOP
  headers, and WebKit then refused the cached Worker module.

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
