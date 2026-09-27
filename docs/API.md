# API guide

How to use `@edgeproc/browser` 0.1.0 in an app. For how it works inside, see
[ARCHITECTURE.md](ARCHITECTURE.md).

## What you import

| Import | What it gives you |
| --- | --- |
| `@edgeproc/browser` | `EngineClient` (talks to the Worker), `syncIndex` and `MemoryCacheStore` (the checking core, also usable in Node), error classes, keyring helpers, the network monitor channel |
| `@edgeproc/browser/worker` | The Worker entry. Import it from your own worker file |
| `@edgeproc/browser/spawn` | `spawnEngineClient()` for unbundled browser ESM, where you have no bundler to own the Worker URL |
| `@edgeproc/browser/vector` | `FlatVectorIndex` and `PackedVectorIndex`, exact in-memory similarity search |
| `@edgeproc/browser/vector/sqlite` | `createSqliteVectorIndex`, a vector index kept in SQLite in OPFS |
| `@edgeproc/browser/vector/sqlite/node` | `createNodeSqliteVectorIndex`, the same SQLite runtime in Node, in memory |
| `@edgeproc/browser/sqlite` | `createSqliteStateStore`, app state in one real SQLite file |

## Publish a bundle

The package checks bundles; it does not make them. Use the Python CLI from
[`edge-proc`](https://github.com/hseshadr/edge-proc) (install with the `bundles` extra):

```bash
uvx --from 'edge-proc[bundles]' edgeproc keygen --out keys
uvx --from 'edge-proc[bundles]' edgeproc publish --src data --origin-dir public/bundle \
  --key keys/private.key --bundle-id prices --version v1 --sequence 1
```

Always pass `--sequence`, and raise it every time you publish. This package refuses a pointer
without one (`IntegrityError: signed latest pointer is missing a non-negative monotonic
sequence`), and uses it to refuse rollbacks. Keep `private.key` secret and off your web
server. Serve `public.key` from your own origin over HTTPS.

## Sync in a Web Worker (Vite)

With Vite, keep the Worker entry in your own source so the bundler owns its URL:

```ts
// src/edgeproc.worker.ts
import "@edgeproc/browser/worker";
```

```ts
// main thread
import { EngineClient } from "@edgeproc/browser";
import EdgeProcWorker from "./edgeproc.worker?worker";

const client = new EngineClient(new EdgeProcWorker(), { idleTimeoutMs: 60_000 });
const result = await client.sync(bundleBaseUrl, pubkeyUrl, {
  expectedBundleId: "my-bundle",
  expectedChannel: "stable",
  wantedPaths: ["catalog_meta.json", "images/"],
  onProgress: ({ phase }) => renderPhase(phase),
});

const bytes = await client.readFile("catalog_meta.json"); // checked, or it throws
await client.clear(); // same cross-tab lock as sync and read
```

`wantedPaths: undefined` syncs every signed file. `wantedPaths: []` checks and promotes only
the signed pointer and manifest, so an app can look at the catalog first and fetch a chosen
directory later. Every checked chunk reports progress and resets the client's idle timer.

`expectedBundleId` and `expectedChannel` only work if the publisher signed them into the
pointer (`edgeproc publish --bind-identity --channel stable`). `undefined` skips a pin;
`null` requires the field to be absent.

Errors from the Worker arrive as `EngineOperationError` with a `code`: `integrity`,
`rollback`, `network`, `lock`, `storage`, or `internal`. The full list is in
[ARCHITECTURE.md](ARCHITECTURE.md#every-refusal-and-its-error).

## Unbundled browser ESM

The root `EngineClient` export contains no Worker URL, so Vite does not emit a second, unused
Worker next to yours. Without a bundler, use the separate spawn helper:

```ts
import { spawnEngineClient } from "@edgeproc/browser/spawn";

const client = spawnEngineClient({ idleTimeoutMs: 60_000 });
```

`test/vite-consumer.test.ts` builds the recommended setup through Vite and proves exactly one
engine Worker is emitted.

## Checking without a Worker (and in Node)

`syncIndex` is the same checking logic without the Worker. You inject the transport, so it
also runs in Node for tests and build scripts:

```js
import { MemoryCacheStore, materializeFile, syncIndex, verifyEd25519 } from "@edgeproc/browser";

const store = new MemoryCacheStore();
const result = await syncIndex({ baseUrl: "/bundle", store, fetchBytes, verify });
const manifest = JSON.parse(new TextDecoder().decode(await store.getManifest(result.manifestHash)));
const bytes = await materializeFile(store, manifest, "prices.json");
```

Pass either `verify` (a single-key function, as above with `verifyEd25519`) or `keyring`
(from `parseTrustRoot` or `loadTrustRoot`), not both. `now` injects the expiry clock in Unix
seconds.

At runtime the package is browser-first: modules reference `BroadcastChannel`,
`PerformanceObserver`, `navigator.storage` and `WorkerGlobalScope`. It loads in Node, then
fails the moment it touches a browser global. The pure core (`crypto`, `canonical`,
`integrity`, `zstd`, and `sync` with `MemoryCacheStore`) runs anywhere.

## The trust root: one key, or a keyring

`pubkeyUrl` is fetched with `no-store` and capped at 64 KiB. Its format is detected:

- **exactly 32 bytes:** a raw Ed25519 public key (a keyring of one);
- **anything else:** a strict JSON keyring.

```json
{
  "schema": "edgeproc.keyring/v1",
  "keys": [
    { "key_id": "34750f98bd59fcfc", "public_key": "8a88e3dd…6f5c" },
    { "key_id": "6a3803d5f059902a", "public_key": "8139770e…b394" }
  ],
  "revoked": []
}
```

`key_id` is the first 16 lowercase hex characters of the SHA-256 of the raw 32-byte public
key (`deriveKeyId`), and must match its key. Unknown fields, duplicates, and a ring with no
unrevoked key are rejected with `KeyringError`. `edgeproc keyring` builds these files.

A pointer may carry two optional signed fields. Both are left out of the signed bytes when
absent, so older pointers still verify:

- `key_id`: only that key may verify it. A revoked id fails with `KeyRevokedError`, an
  unlisted one with `UnknownKeyError`. Without `key_id`, any unrevoked key may verify; a
  revoked key never does.
- `expires_at`: Unix seconds. A pointer fetched from the network at or past its deadline
  fails with `PointerExpiredError`. Offline, an expired pointer whose bundle is already
  cached and checked is still served, with `expired: true` on the result, so an offline app
  keeps working and can tell the user the data may be stale.

To rotate keys: publish a keyring with both keys, sign the next pointer with the new key at a
higher `sequence`, then revoke the old key. The last promoted pointer stays the rollback floor
throughout. See [SECURITY.md](../SECURITY.md) for the policy.

## Counting what the Worker fetched

```ts
import { NETWORK_SENTINEL_CHANNEL, isNetworkSentinelReport } from "@edgeproc/browser";

const channel = new BroadcastChannel(NETWORK_SENTINEL_CHANNEL);
channel.onmessage = (event) => {
  if (!isNetworkSentinelReport(event.data)) return; // same origin is not the same as trusted
  // event.data.entries carry epoch timestamps, comparable across contexts
};
```

## Similarity search without FAISS

The vector API is a small interface, not a ranking framework. Use the exact in-memory index
for small data, or SQLite in OPFS when the index must survive a reload:

```ts
import { createSqliteVectorIndex } from "@edgeproc/browser/vector/sqlite";

const index = await createSqliteVectorIndex({ name: "my-catalog", dimension: 384 });

await index.insert([{ id: "sku-1", vector: embedding, metadata: { tenant: "a" } }]);
const nearest = await index.search(query, 10, { tenant: "a" });
const candidates = await index.searchByIds(query, candidateIds); // one exact batch score
await index.deleteWhere({ tenant: "a" }); // needs a non-empty metadata filter
await index.clear(); // returns the exact count; removes every local vector
await index.dispose();
```

This uses SQLite 3.53.4 plus the Apache-2.0 sqlite-vector 1.1.2 extension, statically linked
into a 934,257-byte WASM file. It does not ship FAISS, SQLiteAI sync/memory/network modules,
an embedding model, or a backend. Search is exact FLOAT32 cosine distance; filters are
parameterized equality checks ANDed together. SQLite runs in its own Worker, and persistent
mode uses the OPFS SAH-pool VFS. One index has one owner: a second tab gets a clear open error
after a bounded retry instead of silently sharing a file handle.

For small or throwaway data, import `FlatVectorIndex` from `@edgeproc/browser/vector`: same
contract, no WASM startup. For an immutable FLOAT32 matrix that already came from a signed
bundle, use the synchronous `PackedVectorIndex`: it copies and validates the matrix, computes
exact cosine similarity, keeps producer order on ties, and zeroes its storage on disposal.
Build recipe, source pins, hashes and licenses:
[`src/vector/sqlite/assets/README.md`](../src/vector/sqlite/assets/README.md).

For a Node evaluation job that must use the same SQLite runtime (not a JavaScript
fallback), use the Node-only entry. It is in memory by design:

```ts
import { createNodeSqliteVectorIndex } from "@edgeproc/browser/vector/sqlite/node";

const index = await createNodeSqliteVectorIndex({ name: "recall-eval", dimension: 384 });
// insert/search/searchByIds/deleteWhere/clear work the same way.
await index.dispose();
```

## App state in one SQLite file, without raw SQL

`@edgeproc/browser/sqlite` stores app state in the same SQLite Worker and OPFS runtime.
Values are bytes: you own the encoding (JSON, MessagePack, Protobuf), the package owns
durability, transactions, schema versions and portable database files.

```ts
import { createSqliteStateStore } from "@edgeproc/browser/sqlite";

const state = await createSqliteStateStore({ name: "my-app", initialSchemaVersion: 1 });

const encoded = new TextEncoder().encode(JSON.stringify({ theme: "dark" }));
const write = await state.put("settings", "appearance", encoded);

// One transaction and one epoch for related changes. expectedEpoch is compare-and-swap:
// a stale writer fails with SqliteStateConflictError and writes nothing.
await state.batch(
  [
    { type: "put", namespace: "profiles", key: "primary", value: profileBytes },
    { type: "delete", namespace: "drafts", key: "profile" },
  ],
  { expectedEpoch: write.epoch },
);

const backup = await state.exportBytes(); // real application/x-sqlite3 bytes
const staged = await state.stageImport(backup); // header, identity, schema, integrity
await state.commitImport(staged.stageId, {
  expectedEpoch: (await state.runtimeInfo()).epoch,
}); // one transaction replaces the state table

await state.dispose();
```

There is no `exec()` or query-string escape hatch. `get`, bounded `list`, `put`, `delete`,
`batch`, `migrate`, `reset`, integrity, export and staged import are the whole API. An import
never touches live state until commit, and commit rechecks the epoch.

Persistent state uses SQLite's official `opfs-wl` VFS, whose file locks are browser Web
Locks, so several tabs and Workers can open the same store safely. `opfs-wl` needs a
cross-origin-isolated page: serve `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). Without it, opening fails
rather than falling back to unsafe sharing. See [sqlite-state.md](sqlite-state.md) for
migrations, backups, headers and ownership.

## Configuration

There are no environment variables or config files. Everything is an argument:

| Where | Option | What it changes |
| --- | --- | --- |
| `client.sync(baseUrl, pubkeyUrl, options)` | `baseUrl`, `pubkeyUrl` | Where the bundle is, and the trust root (raw key or keyring) |
| `client.sync` options | `expectedBundleId`, `expectedChannel` | Identity pins; `undefined` skips a pin, `null` requires the field to be absent |
| `client.sync` options | `wantedPaths` | `undefined` = every file; `[]` = pointer and manifest only; paths or `dir/` prefixes = a subset |
| `client.sync` options | `onProgress` | Called per phase and per checked chunk |
| `new EngineClient(worker, options)` | `idleTimeoutMs` | How long a silent Worker may go before `WorkerTimeoutError` |
| `syncIndex(...)` | `keyring` or `verify`, `now` | Trust root for direct use; `now` injects the expiry clock |
| Persistent store | `indexedDbLayout` | Reuse an existing IndexedDB database, store and key layout |
| `createSqliteVectorIndex` / `createSqliteStateStore` | `name`, `dimension`, `initialSchemaVersion` | Which local database to open, and its shape |

There are no secrets in the browser: the public key is public, and the private signing key
stays with the publisher.
