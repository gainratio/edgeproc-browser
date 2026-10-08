# Contributing

Thanks for taking a look. This is a small library and the bar is simple: a
change ships with a test, and `pnpm gate` is green. New here? Start with
[Getting started for developers](docs/GETTING_STARTED.md).

## Setup

You need Node >= 22.13 and pnpm. The exact Node version CI uses is 24.

```bash
git clone https://github.com/gainratio/edgeproc-browser.git
cd edgeproc-browser
pnpm install
pnpm gate
```

`pnpm gate` runs lint (biome), typecheck (tsc), the build (tsc), then the tests
with coverage (vitest) — the same command, in the same order, that CI runs. The
build comes *before* the tests on purpose: `files: ["dist"]` means consumers get
only the build output, and `test/dist-contract.test.ts` reads that output off
disk. If the gate passes locally it should pass in CI. If it doesn't, that gap
is a bug worth reporting.

## Making a change

1. Branch off `main`.
2. **Write the failing test first.** Watch it fail for the right reason, then
   make it pass. Bug fixes start with a test that reproduces the bug.
3. Run `pnpm gate`. Coverage thresholds are enforced by `vitest.config.ts`:
   90% lines, 90% statements, 90% functions, 85% branches. They are floors, not
   targets — the measured numbers rounded down, so the gate fails the moment
   coverage slips. Raise them when a change earns it; never lower them. This
   package is a browser boundary, not pure logic, so a few paths genuinely
   cannot be reached under jsdom; `vitest.config.ts` names each exclusion and
   why. They are Worker entry points and the Worker-only SQLite loader
   (`src/sql/workerRuntime.ts`); the chunk store itself is tested against the
   real `sqlite3.wasm`.
4. Add a line to `CHANGELOG.md` under `[Unreleased]`.
5. Open a pull request describing what changed and why.

`pnpm lint:fix` will fix formatting for you. `pnpm test:watch` is the fast loop.

## Bumping SQLite, sqlite-vector or emsdk

The rule is to build on the latest SQLite, sqlite-vector and emsdk.
`scripts/build-sqlite-vector-wasm.sh` pins all three exactly, so builds are
reproducible. A weekly workflow (`.github/workflows/sqlite-latest.yml`, also
runnable by hand from the Actions tab) compares those pins with upstream. When
one is behind, it opens or updates a single issue, **SQLite/sqlite-vector update
available**, listing the values to pin. Run the same check locally with
`node scripts/check-sqlite-latest.mjs`.

To bump:

1. In `scripts/build-sqlite-vector-wasm.sh`, set the values from the issue:
   `SQLITE_URL` and `SQLITE_SHA3` (also rename the `sqlite-src-NNNNNNN`
   directory used further down), `VECTOR_COMMIT`, and `EMSDK_IMAGE`.
2. Run the script. It needs Docker, because it builds inside the pinned emsdk
   image. The first run fails on the output hash checks. That is expected: put
   the new `sqlite3-bundler-friendly.mjs`, `sqlite3.wasm` and
   `sqlite3-opfs-async-proxy.js` SHA-256 values into the script, then run it again.
   If a patch in `scripts/sqlite-wasm-patches/` no longer applies, update it.
3. Run `pnpm gate` (it includes `verify:dist`) and `pnpm test:browser`.
4. Add a `CHANGELOG.md` line, open a PR, and release as usual by pushing a
   `v*` tag after it merges. Close the update issue.

## Things that will be pushed back on

- **Renaming a shipped export.** Every name in `src/index.ts` — especially the
  error classes consumers catch by identity, like `SignatureError` and
  `RollbackError` — is a public API contract. Deprecate and add; never rename in
  place.
- **Adding a runtime dependency.** There are exactly three (`@noble/ed25519`,
  `@hpcc-js/wasm-zstd` and `age-encryption`, the last loaded only by the `/seal`
  subpath), doing signatures, decompression and passphrase encryption, which have no
  business being hand-rolled. Storage uses the bundled SQLite WASM. A third needs the same justification: make the
  case in the issue before writing the code.
- **Widening the surface without a use case.** New exports need a caller.

## Reporting bugs

Open an issue with the version you're on, what you passed in, what you got back,
and what you expected. A failing test is the best possible bug report.

For anything security-related, see [SECURITY.md](./SECURITY.md) — do not open a
public issue.
