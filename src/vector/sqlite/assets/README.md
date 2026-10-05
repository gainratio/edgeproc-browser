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
| Emscripten | 6.0.11 | image `emscripten/emsdk@sha256:cdefec943f04fd4b2b2fe23b0a1a346be9fc560ef5784a83faa27dd351381372` |

The build strips with the image's own `llvm-strip` (no apt packages, so the
image digest pins the whole toolchain). SQLite's makefile runs `wasm-opt
--all-features`; under Binaryen 133 that turns on the compact-imports
encoding (import kind `0x7f`), which no shipping browser can compile, so the
script appends `--disable-compact-imports`.

Emscripten 6.0.2 dropped `wasmBinary` from the loader's default incoming
Module API; the script passes `-sINCOMING_MODULE_JS_API` with the 6.0.11
default list plus `wasmBinary`, because the Node entry hands the loader the
wasm bytes that way.

### Build flags measured and left off (2026-10-04)

Measured on 720 x 384 (edge-reco) and 31,348 x 384 (aml-filter) synthetic
unit vectors with `vector_full_scan`, plus an FTS5 prefix `MATCH`, in
Playwright Chromium, Firefox and WebKit:

- **WASM SIMD (`-msimd128`)**: sqlite-vector's `distance-cpu.c` has scalar
  kernels only (its SIMD kernels are x86 SSE/AVX and ARM NEON files that
  this build does not compile), so SIMD only enables autovectorisation. It
  was 5-20% slower in Chromium and WebKit.
- **Relaxed SIMD (`-mrelaxed-simd`)**: byte-identical to the SIMD build; the
  compiler emits no relaxed instructions for this code.
- **`-O3`**: +79% wasm size (1.67 MB) for under 6% in Chromium and none in
  WebKit.
- **`-flto`**: 0.2% smaller, no measurable speed change.
- **Native WASM exceptions**: not applicable; SQLite is C with no
  `setjmp`/`longjmp` or C++ exceptions.

## Local patches

Two patches in `scripts/sqlite-wasm-patches/` sit on top of the pinned
upstream files; the build script applies them in order after the Emscripten
build, so the table below lists the patched outputs. Upstream 3.53.4 is the
latest release (npm `@sqlite.org/sqlite-wasm@3.53.4-build1` carries the same
code), so there is nothing newer to upgrade to.

### 0004: opfs-sahpool never sleeps in its busy handler (upstream backport)

`0004-sahpool-xsleep-noop.patch` is SQLite check-in
[c9dd4d88e4](https://sqlite.org/src/info/c9dd4d88e4) (cherry-picked to
branch-3.53 as f774529206; forum report
[3f0794c5d8](https://sqlite.org/forum/forumpost/3f0794c5d8)), copied verbatim
from `ext/wasm/api/sqlite3-vfs-opfs-sahpool.c-pp.js` into the built bundle.

Why: the sahpool inherited `xSleep` from the default VFS. Contention in a
sahpool can only come from another handle in the same thread, so a busy handler
that sleeps freezes that thread without ever letting the other handle finish.
With 0003, `xLock` can return `SQLITE_BUSY`, so this matters: in
`src/sql/sahpoolLocking.test.ts` a second writer with `busy_timeout = 3000`
blocked for 3,006 ms without the patch and fails fast with it. Drop the patch
when the pinned release contains c9dd4d88e4.

### 0003: two handles on one file lock against each other (upstream backport)

`0003-sahpool-lock-table.patch` is SQLite check-in
[9e2caaa382](https://sqlite.org/src/info/9e2caaa382) (GitHub mirror
3b28aa1ce7), copied verbatim from `ext/wasm/api/sqlite3-vfs-opfs-sahpool.c-pp.js`
into the built bundle.

Why: 3.53.4's sahpool `xLock` always succeeded, so two connections on the same
file in one thread could both take a write lock and both write. The patch adds
a per-path lock table modelled on `os_unix.c`'s `unixInodeInfo`: a conflicting
lock returns `SQLITE_BUSY`, closing a handle drops its lock, `hasReservedLock`
(0002) reads the table, and `releaseAccessHandles` clears it.
`src/sql/sahpoolLocking.test.ts` runs the pinned build's sahpool in Node on an
in-memory OPFS and fails without the patch (the second `BEGIN IMMEDIATE`
succeeded). Drop the patch when the pinned release contains 9e2caaa382.

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
| `sqlite3.mjs` | 817,412 | `4ff745643ccc3c71df601742470cd96c2bef7c2f3b0959f32a49d596f8ab8392` |
| `sqlite3.wasm` | 932,259 | `6a6f7e4b0f4249300964bd402a084387eea5df2120d2eca61bdfbff9eb226b58` |
| `sqlite3-opfs-async-proxy.js` | 42,696 | `e9a55a030682ca706c7ada8cb521718c6730a2637c6f1a8b63a677a635e035f7` |

SQLite is public domain; its blessing/license text is preserved in
`LICENSE.sqlite.md`. sqlite-vector 1.1.2 is Apache-2.0; its license is preserved
in `LICENSE.sqlite-vector.md`. `THIRD_PARTY_NOTICES.md` preserves the notices
for FP16, Emscripten, and the linked musl runtime.
