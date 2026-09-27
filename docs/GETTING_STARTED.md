# Getting started for developers

From zero to a green local build and your first change. Every command here was run from a
fresh clone on macOS on 25 Sep 2026. Times are from that run, on a busy machine with warm
package caches; a first run downloads more.

## 1. What you need

| Tool | Version | How to get it |
| --- | --- | --- |
| Node | 24.x (CI uses 24; `package.json` allows 22.13 or newer) | `nvm install 24 && nvm use 24`, or your usual Node manager |
| pnpm | 11.5.0, pinned in `package.json` | `corepack enable` (corepack ships with Node) |
| git | any recent version | the preflight tests create throwaway git repos |
| Chromium for Playwright | whatever `@playwright/test` pins | `pnpm exec playwright install chromium` (only for the browser tests) |

You do not need Python, Docker, or an account for anything below.

**Traps we actually hit:**

- **Node 26 breaks the corepack pnpm shim.** Every `pnpm` command fails with
  `TypeError [ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING]`. Switch to Node 24, run
  `corepack enable` again, and check `pnpm -v` prints `11.5.0`.
- **The publish-preflight tests are slow on a loaded machine.** They create real git repos
  and have a 5-second timeout. On a machine with a very high load average, one of them can
  time out (`test/publish-preflight.test.ts ... Test timed out in 5000ms`). Rerun when the
  machine is quieter, or check that file alone with
  `pnpm exec vitest run test/publish-preflight.test.ts --testTimeout=60000`.

## 2. Clone, install, and run it

```bash
git clone https://github.com/hseshadr/edgeproc-browser
cd edgeproc-browser
corepack enable
pnpm install --frozen-lockfile     # about 5 s; ends with "Done in ... using pnpm v11.5.0"
pnpm demo                          # about 4 s
```

`pnpm install` also builds `dist/` (the `prepare` script). `pnpm demo` builds, then runs
[`examples/quickstart.mjs`](../examples/quickstart.mjs) against the real signed bundle in
`src/engine/__fixtures__/bundle`, with no network. Success looks like this:

```text
1. syncing the signed bundle into a content-addressed store...
   version        v1
   manifest       81a71fb0ba2f01ed...
   chunks fetched 783, reused 0
   bytes fetched  2018076
   http requests  785

2. reassembling 728 files, each verified...
   all 728 files match their signed sha256.

3. a second sync over the primed store refetches nothing:
   chunks fetched 0 (reused 783)

4. fail-closed check — same bundle, one bit flipped in the key:
   rejected with SignatureError — fail-closed holds.
```

## 3. The one command CI runs

```bash
pnpm gate                          # 30-50 s
```

This runs, in order: lint (Biome), typecheck (tsc), build, `verify:dist` (a clean build must
match the committed `dist/`), then every unit test with coverage (Vitest). Success ends with
`Test Files  37 passed (37)` and no `ERROR: Coverage` lines. Coverage floors are 90% lines,
statements and functions, 85% branches.

CI also runs the real-browser tests, so run them before a PR that touches the Worker, OPFS,
or SQLite:

```bash
pnpm exec playwright install chromium   # once, about 2 s if cached
pnpm test:browser                       # about 9 s; ends with "3 passed"
```

## 4. Map of the code

| Path | What it is |
| --- | --- |
| `src/index.ts` | The public API. Every name exported here is a contract; do not rename one in place |
| `src/engine/sync.ts` | The sync state machine: pointer, rollback check, manifest, missing chunks, promotion |
| `src/engine/integrity.ts`, `crypto.ts`, `canonical.ts`, `zstd.ts` | Hash checks, Ed25519, canonical JSON bytes, bounded decompression |
| `src/engine/keyring.ts` | Raw-key and keyring trust roots, key ids, revocation |
| `src/engine/client.ts`, `worker.ts`, `protocol.ts` | Main-thread `EngineClient`, the Worker entry, and the messages between them |
| `src/engine/opfsStore.ts`, `indexedDbStore.ts`, `persistentStore.ts`, `memoryStore.ts` | Where checked chunks and pointers are stored |
| `src/engine/networkSentinel.ts` | Reports the Worker's own network requests to the page |
| `src/vector/` | Exact similarity search: in memory, and in SQLite (`vector/sqlite/`, with the WASM in `assets/`) |
| `src/sqlite/` | The app-state store over the same SQLite Worker |
| `src/engine/__fixtures__/bundle/` | A real signed bundle (783 chunks) used by tests and the demo |
| `test/` | Contract tests on the build output, README, workflows and publish script; `test/browser/` holds the Playwright tests |
| `dist/` | Committed build output. `pnpm build` rewrites it; commit it with your source change |

Unit tests sit next to the code as `*.test.ts`. Refusal paths often have their own file, such
as `client.refusals.test.ts` and `fetchBytes.refusals.test.ts`.

## 5. Make your first change

A typical change adds or tightens a refusal. Say you want a clearer error when a chunk fails
its hash check.

1. Branch: `git switch -c fix/clearer-chunk-error`.
2. Write the failing test first, next to the code. For the chunk check that is
   `src/engine/integrity.test.ts`. Assert the error type and the message you want.
3. Run just that file and watch it fail for the right reason:

   ```bash
   pnpm exec vitest run src/engine/integrity.test.ts --coverage.enabled=false   # about 2 s
   ```

4. Change `src/engine/integrity.ts` until it passes. `pnpm test:watch` gives a fast loop.
5. Run `pnpm gate`. It rebuilds `dist/`; commit the changed `dist/` files with your source,
   or `verify:dist` fails in CI.
6. Add a line to `CHANGELOG.md` under `[Unreleased]`.

`pnpm lint:fix` fixes formatting for you.

## 6. Open a pull request

- **Branch names** follow the commit type: `feat/...`, `fix/...`, `docs/...`.
- **Commit messages** use the same prefix (`fix(sync): ...`, `docs: ...`), as in `git log`.
- **CI runs three checks** on every PR to `main`: a full-history secret scan (gitleaks),
  `pnpm gate`, and `pnpm test:browser` in Chromium. All three must pass.
- **Reviewers look for:** a test that fails without your change; no renamed exports in
  `src/index.ts` (deprecate and add instead); no new runtime dependency without a case made
  in an issue first; no new export without a caller. See
  [CONTRIBUTING.md](../CONTRIBUTING.md).
- Security issues go through [SECURITY.md](../SECURITY.md), not a public issue.
