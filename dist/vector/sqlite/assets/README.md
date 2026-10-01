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

## Expected outputs

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `sqlite3.mjs` | 809,712 | `b96e0c4faa11f7220e4916788208302944bd995ba79d01c9f2ba726280b0fbc3` |
| `sqlite3.wasm` | 934,257 | `a847545f7c58e1bdf9074cda354cfbd992c7edadf67cf4011e76297317c2565a` |
| `sqlite3-opfs-async-proxy.js` | 41,758 | `0afe66f23424456c0eb1de5f599075fd676d869044a017a1058888007e2dbf92` |

SQLite is public domain; its blessing/license text is preserved in
`LICENSE.sqlite.md`. sqlite-vector 1.1.2 is Apache-2.0; its license is preserved
in `LICENSE.sqlite-vector.md`. `THIRD_PARTY_NOTICES.md` preserves the notices
for FP16, Emscripten, and the linked musl runtime.
