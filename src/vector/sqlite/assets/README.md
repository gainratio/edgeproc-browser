# Minimal SQLite + sqlite-vector browser runtime

These runtime files are shared by `@gainratio/browser/vector/sqlite` and
`@gainratio/browser/sqlite`:

- `sqlite3.mjs`: the official SQLite bundler-friendly JavaScript loader.
- `sqlite3.wasm`: SQLite 3.53.4 with only sqlite-vector 1.1.2 statically linked.
- `sqlite3-opfs-async-proxy.js`: SQLite's official OPFS proxy used by the
  multi-tab `opfs-wl` VFS. The vector adapter continues using its SAH pool.

The build intentionally excludes SQLiteAI sync, memory, and network modules. It
also excludes the stock SQLiteAI WASM bundle. `scripts/build-sqlite-vector-wasm.sh`
reproduces all three files with a digest-pinned Emscripten image.

## Pinned sources

| Input | Pin | Integrity |
| --- | --- | --- |
| SQLite | `sqlite-src-3530400.zip` (3.53.4) | SHA3-256 `b834d474b9b393d85a9e3ee4cc11f1329e007e9376a424ee740796f5c4bda3a8` |
| sqlite-vector | commit `0c2223ada9dce1fa33248c8835a15f51d9a0f655` (1.1.2) | Git object ID |
| Emscripten | 4.0.15 | image `emscripten/emsdk@sha256:27bc6267cb285223b8aebb7627bfebae7cb3ad2aaa0d5923b8aa5321793033e8` |

## Local patches

Two patches in `scripts/sqlite-wasm-patches/` sit on top of the pinned
upstream files; the build script applies them in order after the Emscripten
build, so the table below lists the patched outputs. Upstream 3.53.4 is the
latest release (npm `@sqlite.org/sqlite-wasm@3.53.4-build1` carries the same
code), so there is nothing newer to upgrade to.

### 0002: opfs-sahpool rolls back hot journals (upstream backport)

`0002-sahpool-check-reserved-lock.patch` is SQLite check-in
[ea1d55e202e6e](https://sqlite.org/src/info/ea1d55e202e6e) on branch-3.53
(the same change as trunk check-in
[9168a6f1be](https://sqlite.org/src/info/9168a6f1be); forum report
[b2fbb61642](https://sqlite.org/forum/forumpost/b2fbb61642)), copied verbatim
from `ext/wasm/api/sqlite3-vfs-opfs-sahpool.c-pp.js` into the built bundle.

Why: 3.53.4's sahpool `xCheckReservedLock` always answered "a RESERVED lock is
held", so the pager never treated a leftover rollback journal as hot. A Worker
killed mid-transaction left a torn database that `PRAGMA integrity_check`
could still call `ok`. With the patch the answer comes from the pool's open
handles, the next open rolls the journal back, and
`test/browser/hot-journal.spec.ts` proves it for `/sql` and `/vector/sqlite`.
Drop the patch when the pinned release contains ea1d55e202e6e;
`scripts/check-sqlite-latest.mjs` says so in its weekly issue.

### 0001: the OPFS async proxy is inline and reports itself alive

`0001-opfs-async-proxy-inline-and-alive.patch`.

Why: `sqlite3.mjs` installs its `opfs` and `opfs-wl` VFSes by spawning
`sqlite3-opfs-async-proxy.js` as a nested Worker and gives that spawn 4 s (its
"zombie timer", a workaround for a Worker load that fails without resolving or
rejecting). Spawned from a URL that is a network fetch; on slow 4G under an
8-way chunk sync it lost the race, both VFSes were skipped with a console
warning, and `@edgeproc/browser/sqlite` could not open its durable store.

1. `sqlite3.mjs`: honour `sqlite3ApiConfig.opfsProxyUri` (upstream's documented
   client-config hook) as the proxy Worker's URI, passing the VFS name as the
   Worker's `name`; fall back to the networked spawn if the browser refuses it.
2. `sqlite3.mjs` + proxy: the proxy posts `opfs-async-alive` as soon as it runs
   and the installer clears the zombie timer on it, so a slow OPFS root (a busy
   low-end device, or OPFS contended by other work) is waited on rather than
   mistaken for a dead Worker.
3. proxy: reads the VFS name from `globalThis.name` when the URL carries none
   (a Blob URL has no query string), and posts `opfs-unavailable` with the
   reason when `navigator.storage.getDirectory()` rejects. Upstream only logged
   that and left the zombie timer to fail the install 4 s later.

`opfsAsyncProxySource.ts` is generated from the patched proxy by
`scripts/generate-opfs-proxy-source.mjs`; both SQLite Workers hand it to the
loader as a same-origin Blob URL (`../opfsAsyncProxy.ts`). The Chromium proofs
are in `test/browser/opfs-install.spec.ts`.

## Expected outputs

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `sqlite3.mjs` | 812,357 | `9386833bbe0c3d723e1f2d25721917c790cfce4d01770c605c59ff2eb7b6d7b2` |
| `sqlite3.wasm` | 934,257 | `a847545f7c58e1bdf9074cda354cfbd992c7edadf67cf4011e76297317c2565a` |
| `sqlite3-opfs-async-proxy.js` | 42,696 | `e9a55a030682ca706c7ada8cb521718c6730a2637c6f1a8b63a677a635e035f7` |

SQLite is public domain; its blessing/license text is preserved in
`LICENSE.sqlite.md`. sqlite-vector 1.1.2 is Apache-2.0; its license is preserved
in `LICENSE.sqlite-vector.md`. `THIRD_PARTY_NOTICES.md` preserves the notices
for FP16, Emscripten, and the linked musl runtime.
