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

`scripts/sqlite-wasm-patches/0001-opfs-async-proxy-inline-and-alive.patch`
sits on top of the pinned upstream files; the build script applies it after
the Emscripten build, so the table below lists the patched outputs. Upstream
3.53.4 is the latest release (npm `@sqlite.org/sqlite-wasm@3.53.4-build1`
carries the same code), so there is nothing newer to upgrade to.

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
| `sqlite3.mjs` | 811,287 | `7111103823ce7e51c165724bee0bf66e8048fb7fb9bfbce69c7f2ee664e4a5fa` |
| `sqlite3.wasm` | 934,257 | `a847545f7c58e1bdf9074cda354cfbd992c7edadf67cf4011e76297317c2565a` |
| `sqlite3-opfs-async-proxy.js` | 42,696 | `e9a55a030682ca706c7ada8cb521718c6730a2637c6f1a8b63a677a635e035f7` |

SQLite is public domain; its blessing/license text is preserved in
`LICENSE.sqlite.md`. sqlite-vector 1.1.2 is Apache-2.0; its license is preserved
in `LICENSE.sqlite-vector.md`. `THIRD_PARTY_NOTICES.md` preserves the notices
for FP16, Emscripten, and the linked musl runtime.
