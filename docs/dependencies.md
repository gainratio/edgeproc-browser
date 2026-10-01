# Runtime dependency provenance

`@gainratio/browser` keeps the browser substrate small and auditable:

| Package | Pinned range | Purpose | License |
|---|---:|---|---|
| `@noble/ed25519` | `^3.1.0` | Ed25519 verification | MIT |
| `@hpcc-js/wasm-zstd` | `^1.15.0` | bounded zstd decompression | Apache-2.0 |
| `idb-keyval` | `^6.3.0` | small IndexedDB transaction helpers | Apache-2.0 |

The optional `@gainratio/browser/sqlite` and
`@gainratio/browser/vector/sqlite` subpaths share one self-hosted runtime. It
carries exact SQLite/sqlite-vector versions, artifact hashes, a rebuild recipe,
and license texts in `src/vector/sqlite/assets/`. The application-state API does
not call the vector extension; sharing the artifact avoids shipping a second
SQLite WASM binary when a consumer uses both Legos.
