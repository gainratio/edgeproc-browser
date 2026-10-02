# SQLite application-state contract

## TL;DR

`@gainratio/browser/sqlite` stores namespaced byte values in one real SQLite
database. Writes are transactional, every committed change advances a monotonic
epoch, stale compare-and-swap writes fail closed, and backup restore is a
validate-then-commit operation. Callers never receive an arbitrary SQL API.

Use it when a browser application wants one portable canonical store instead of
several unrelated IndexedDB schemas. Keep domain encoding and migration policy
in the application; keep persistence mechanics here.

## Quickstart

```ts
import {
  createSqliteStateStore,
  SqliteStateConflictError,
} from "@gainratio/browser/sqlite";

const state = await createSqliteStateStore({
  name: "acme-console",
  initialSchemaVersion: 1,
  persistence: "opfs", // default
});

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const decode = <T>(bytes: Uint8Array): T =>
  JSON.parse(new TextDecoder().decode(bytes)) as T;

const first = await state.put("preferences", "current", encode({ locale: "en" }));

try {
  await state.batch(
    [
      { type: "put", namespace: "chat", key: "thread-1", value: encode(messages) },
      { type: "put", namespace: "memory", key: "thread-1", value: encode(summary) },
    ],
    { expectedEpoch: first.epoch },
  );
} catch (error) {
  if (!(error instanceof SqliteStateConflictError)) throw error;
  // Reload and deliberately reconcile. Nothing in the rejected batch was written.
}

const row = await state.get("preferences", "current");
if (row) console.log(decode<{ locale: string }>(row.value));
await state.dispose();
```

## Data model

- A row is `{ namespace, key, value: Uint8Array, revision }`.
- `(namespace, key)` is unique.
- `revision` is the database epoch that last wrote the row.
- One successful batch advances the epoch once, no matter how many rows it
  changes. An empty/no-op batch does not advance it.
- `list()` is key-ordered and bounded to at most 1,000 rows per page. Continue
  with the returned `nextKey`; there is no unbounded dump method.

Bytes keep this library neutral. JSON is easy to inspect, MessagePack is small,
and Protobuf gives a durable typed schema. Pick one in the application and
record the codec version in the encoded value or application schema.

## Schema migration

`initialSchemaVersion` initializes a new database only. It never rewrites the
version of an existing store. Upgrade explicitly:

```ts
await state.migrate({
  fromVersion: 1,
  toVersion: 2,
  expectedEpoch: current.epoch,
  mutations: transformedRows,
});
```

The source-version check, CAS check, mutations, version update, and epoch update
share one SQLite transaction. A wrong version, stale epoch, or failed mutation
rolls everything back. The library's private physical schema has a separate
format version and refuses unknown formats rather than silently downgrading
them.

## Portable backup and restore

`exportBytes()` runs SQLite's integrity check and returns a standard SQLite
database byte array beginning with `SQLite format 3`. The exported database can
be archived as `application/x-sqlite3` and inspected with ordinary SQLite tools.

Restore has two explicit phases:

1. `stageImport(bytes)` checks the byte cap, SQLite header, application ID,
   private schema, integrity, metadata, rows, and row revisions. It changes
   nothing in the live database.
2. `commitImport(stageId, { expectedEpoch })` rechecks CAS, replaces all state
   rows and schema metadata in one transaction, and advances to an epoch higher
   than both databases. A stage is single-use. `discardImport()` drops it.

Only one staged snapshot is held in Worker memory at a time. The default import
cap is 64 MiB and can be reduced or raised (up to 1 GiB) with `maxImportBytes`.

## Multi-tab ownership

Persistent mode uses SQLite 3.53.4's official `opfs-wl` VFS. It maps SQLite
`xLock`/`xUnlock` to origin-wide browser Web Locks, so separate tabs and Workers
can safely open the same file. Rollback-journal transactions and a five-second
busy timeout provide the database-level exclusion; the epoch CAS provides the
application-level stale-write verdict.

CAS mutations add a second, store-scoped Web Lock around the whole operation,
including the epoch read. This is intentional. SQLite file locking alone can
allow two connections to validate the same application epoch before their
commits serialize. The outer lock makes epoch comparison and the following
`BEGIN IMMEDIATE` transaction one cross-Worker critical section.

Two tabs can read concurrently. If tab A commits epoch 8, tab B's later batch
with `expectedEpoch: 7` fails with `SqliteStateConflictError` before changing a
row. The caller reloads and decides how to reconcile. A non-CAS write is still
SQLite-atomic, but deliberately accepts last-committer-wins semantics.

The store fails explicitly if `opfs-wl` is unavailable; it never falls back to
an OPFS mode that only appears multi-tab safe because each connection happens
to run in a dedicated Worker. `persistence: "memory"` remains isolated per
Worker and has no reload durability. The existing vector adapter is separate
and retains its single-owner SAH-pool behavior.

`opfs-wl` requires `SharedArrayBuffer` and `Atomics.waitAsync`, which in turn
requires a cross-origin-isolated document. A typical same-origin deployment
adds these response headers to HTML, Worker, JS, and WASM responses:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

`Cross-Origin-Embedder-Policy: credentialless` may be a better fit when the
target browsers and asset policy permit it. In either case, test every
cross-origin model, font, image, iframe, and OAuth path: COEP blocks resources
that do not opt in via CORS/CORP. The Chromium contract test asserts
`crossOriginIsolated === true`, opens two Workers at once, proves shared
visibility, and races two writes at the same expected epoch. Exactly one commits
and the other receives `SqliteStateConflictError`.

## Security and privacy boundaries

- No public arbitrary-SQL method exists. Every value and key is bound as a
  parameter.
- Persistent databases enable `secure_delete` and use rollback-journal mode.
- Import accepts only this package's application ID and exact physical schema;
  extra tables, views, indexes, and triggers are rejected.
- Imported databases run with `trusted_schema=OFF` and `query_only=ON` while
  being inspected.
- SQLite and sqlite-vector are self-hosted assets. State operations make no
  external request; the real Chromium test verifies this.

This is local durability, not encryption. Encrypt sensitive values before
`put()` when device-at-rest confidentiality is part of the threat model.
