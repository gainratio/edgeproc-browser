# SQL in the browser: `@gainratio/browser/sql`

**TL;DR:** `openSqlDatabase({ name })` gives you a real SQLite database in a Worker, stored in
OPFS, with FTS5 (keyword search with `bm25()`), JSON1 and sqlite-vector on the **same
connection**. One database can hold your rows, their keyword index and their vectors, and one
SQL query can join all three.

**Why:** apps were loading this package's `sqlite3.mjs` by file path and writing their own
Worker, OPFS and memory-profile wiring around it. That breaks on any upgrade and every app
does it slightly differently. The library already ships the build, so it owns the Worker too.

## Quickstart

```ts
import { openSqlDatabase } from "@gainratio/browser/sql";

const db = await openSqlDatabase({ name: "catalogue", fallback: "memory" });
if (db.storage.persistence === "memory") {
	console.warn(`catalogue is in memory: ${db.storage.reason}`);
}

await db.exec(`
	CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, title TEXT NOT NULL, embedding BLOB);
	CREATE VIRTUAL TABLE IF NOT EXISTS products_fts
		USING fts5(title, content='products', content_rowid='id');
`);

// Bulk load: one transaction, each statement prepared once.
await db.transaction([
	{ sql: "DELETE FROM products" },
	{
		sql: "INSERT INTO products(id, title, embedding) VALUES (?, ?, ?)",
		rows: [
			[1, "red running shoes", new Float32Array([1, 0, 0])],
			[2, "blue rain jacket", new Float32Array([0, 1, 0])],
			[3, "red wool scarf", new Float32Array([0.9, 0.1, 0])],
		],
	},
	{ sql: "INSERT INTO products_fts(products_fts) VALUES ('rebuild')" },
]);
await db.query("SELECT vector_init('products', 'embedding', 'type=FLOAT32,dimension=3')");

// Hybrid search: FTS5 bm25 + vector distance, fused with reciprocal rank in SQL.
const hits = await db.query<{ id: number; title: string; score: number }>(
	`WITH kw AS (
		SELECT rowid AS id, row_number() OVER (ORDER BY bm25(products_fts)) AS r
		FROM products_fts WHERE products_fts MATCH :q
	), knn AS (
		SELECT rowid AS id, row_number() OVER (ORDER BY distance) AS r
		FROM vector_full_scan('products', 'embedding', :v, 10)
	), fused AS (
		SELECT id, sum(1.0 / (60 + r)) AS score
		FROM (SELECT * FROM kw UNION ALL SELECT * FROM knn) GROUP BY id
	)
	SELECT p.id, p.title, fused.score FROM fused JOIN products p USING (id)
	ORDER BY fused.score DESC LIMIT 5`,
	{ ":q": "red", ":v": new Float32Array([1, 0, 0]) },
);

await db.close();
```

Typed arrays such as `Float32Array` are bound as their raw bytes, which is the BLOB layout
sqlite-vector reads. BLOBs come back as `Uint8Array`.

## API

```ts
openSqlDatabase(options: SqlDatabaseOptions, { workerFactory? }?): Promise<SqlDatabase>

interface SqlDatabaseOptions {
	name: string;                       // hashed into the OPFS pool and file name
	persistence?: "opfs" | "memory";    // default "opfs"
	fallback?: "none" | "memory";       // default "none": fail closed
	memoryProfile?: "auto" | "full" | "lite" | "minimal"; // default "auto"
}

interface SqlDatabase {
	readonly name: string;
	readonly storage: SqlStorage;       // where it really lives, see below
	exec(sql, bind?): Promise<SqlExecResult>;            // { changes, lastInsertRowid }
	query<R>(sql, bind?): Promise<R[]>;                  // rows of one statement
	transaction(statements): Promise<SqlTransactionResult>; // BEGIN IMMEDIATE … COMMIT
	transaction<T>(work: (tx) => Promise<T>): Promise<T>;  // interactive, see below
	executeMany(sql, rows): Promise<SqlExecResult>;      // bulk load, one transaction
	prepare(sql): Promise<SqlPreparedStatement>;         // run(bind?) / all(bind?) / finalize()
	exportDatabase(): Promise<Uint8Array>;              // the whole database as a SQLite file
	importDatabase(bytes, options?): Promise<SqlImportResult>; // validate, then replace atomically
	migrateLegacySahPool(options): Promise<LegacySahPoolMigration>; // see below
	runtimeInfo(): Promise<SqlRuntimeInfo>;              // versions, fts5, json1, profile, storage
	close(): Promise<void>;
}

exportDatabase(db | name, { workerFactory? }?): Promise<Uint8Array>
importDatabase(db | name, bytes, options?): Promise<SqlImportResult>
migrateLegacySahPool({ fromPool, fromFile, to: db | name, removeLegacy?, lockName?, importOptions? },
	{ workerFactory? }?): Promise<LegacySahPoolMigration>

// Node test suites: import { openNodeSqlDatabase } from "@gainratio/browser/sql/node"
openNodeSqlDatabase({ name, memoryProfile? }): Promise<SqlDatabase>

removeSqlDatabase(name, { lockWaitMs? }?): Promise<"removed" | "absent" | "in-use" | "timeout">
removeOpfsPool(poolName, { lockWaitMs? }?): Promise<"removed" | "absent" | "in-use" | "timeout">
sqliteVectorPoolName(name): Promise<string>   // pool used by createSqliteVectorIndex
sqlDatabasePoolName(name): Promise<string>    // pool used by openSqlDatabase
```

`bind` is positional (`[1, "a"]`) or named (`{ ":id": 1 }`). In `transaction`, a statement is
`{ sql, bind? }` or `{ sql, rows }` (executemany). Any failure rolls back the whole transaction.

### Interactive transactions (read, decide, write)

When the write depends on what you read, pass a callback. The Worker runs `BEGIN IMMEDIATE`,
your callback reads and writes through `tx`, then `COMMIT`. A throw (or a failed `COMMIT`,
such as a deferred foreign key) rolls everything back and rejects with that error.

```ts
const moved = await db.transaction(async (tx) => {
	const [alice] = await tx.query<{ balance: number }>(
		"SELECT balance FROM accounts WHERE id = ?", ["alice"]);
	if ((alice?.balance ?? 0) < 30) throw new Error("insufficient funds"); // rolls back
	await tx.exec("UPDATE accounts SET balance = balance - 30 WHERE id = 'alice'");
	await tx.exec("UPDATE accounts SET balance = balance + 30 WHERE id = 'bob'");
	return 30; // resolved after COMMIT
});
```

While the callback runs, the handle holds its connection lock: every other call on `db`
(another `transaction`, a plain `query`) waits and runs after `COMMIT` or `ROLLBACK`, in call
order. So two concurrent transfers cannot both read the old balance.

The transaction stays atomic even when the callback misbehaves:

- `tx` refuses transaction control: `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT` and
  `RELEASE` fail with "not authorized" (an SQLite authorizer denies them), so the callback
  cannot end the transaction early. Throw to roll back.
- If SQLite itself ends the transaction (a `RAISE(ROLLBACK)`, or `SQLITE_FULL`, `IOERR` or
  `BUSY` rolling it back), every later `tx` call and the final `COMMIT` reject with
  `SqlTransactionEndedError`, so a callback that catches the error and keeps writing cannot
  write in autocommit. The transaction rejects; its writes are gone.
- `db.close()` does not wait for the callback. It rolls the open transaction back, fails the
  calls queued behind it, closes the connection and ends the Worker; the transaction rejects
  with "SQL database is closed".

Two rules:

- Inside the callback, use `tx`, never `db`. A `db` call waits for the transaction it is
  inside, so it only settles when `close()` ends that transaction.
- Keep the callback short and local: no network calls while holding the write lock.

## Storage status and the in-memory fallback

The database lives in its own `opfs-sahpool` VFS. That VFS holds exclusive OPFS handles, so
only one tab can own it. The Worker takes an exclusive Web Lock for the life of the
connection and waits for a previous owner (a reload) before giving up: 4 s on a `full`
memory tier, 8 s on `lite`, 16 s on `minimal`, because weak devices tear the old page down
slowest. A connection opened while an import or export by name runs waits for it, up to 15
times that budget (60 s on `full`), then fails `pool-in-use` instead of hanging. `createSqliteVectorIndex({ persistence: "opfs" })` takes the same lock; a second tab
gets `SqlStorageUnavailableError("pool-in-use")`.

| `db.storage` | Meaning |
|---|---|
| `{ persistence: "opfs", pool, file }` | On disk. SQLite's page cache and heap limits come from the memory profile. |
| `{ persistence: "memory", reason: "pool-in-use" }` | Another tab owns this database. You asked for `fallback: "memory"`. |
| `{ persistence: "memory", reason: "opfs-unavailable", detail }` | OPFS failed (private browsing, old browser). You asked for `fallback: "memory"`. |
| `{ persistence: "memory", reason: "requested" }` | You passed `persistence: "memory"`. |

The wait is for a previous *connection*. An import, export or migration **by name** is a
bounded operation: it also holds a `${pool}-operation` Web Lock, and a context whose wait runs
out while that lock is held waits for the operation to finish instead of failing. So a writer
opened during `importDatabase(name, …)` waits for the import, however long it takes.

Without `fallback: "memory"`, both failures throw `SqlStorageUnavailableError` with the same
`reason`. Only allow the fallback for small data you rebuild on every boot: an in-memory
database holds everything in the wasm heap, which is how iPhones run out of memory.

On OPFS the Worker also sets `PRAGMA secure_delete = ON` and `journal_mode = DELETE`, and
checks they stuck.

## Delete an old database or pool

Removal is idempotent and deletes nothing unless it returns `"removed"`:

| Result | Meaning |
|---|---|
| `"removed"` | Deleted. |
| `"absent"` | There was nothing to delete. |
| `"in-use"` | A live owner is confirmed: another tab kept the pool's owner lock for the whole wait, or the browser refused to delete files that are open. |
| `"timeout"` | The wait ended but no owner could be confirmed. Call again later. |

Closing first and removing straight after is safe: `db.close()` and `index.dispose()` resolve
only after the Worker has closed the pool's OPFS handles and released its owner lock.

```ts
import {
	removeOpfsPool,
	removeSqlDatabase,
	sqliteVectorPoolName,
} from "@gainratio/browser/sql";

// A database you opened with openSqlDatabase({ name: "catalogue-v1" }).
await removeSqlDatabase("catalogue-v1");

// The pool an older build's createSqliteVectorIndex({ name: "catalog" }) left behind.
await removeOpfsPool(await sqliteVectorPoolName("catalog"));

// A raw opfs-sahpool you installed yourself with installOpfsSAHPoolVfs({ name }).
await removeOpfsPool("edgereco-catalogue");
```

Both take the pool's owner Web Lock, the one `openSqlDatabase` and an OPFS
`createSqliteVectorIndex` hold while open, and delete while holding it, so nothing can reopen
the pool mid-delete. They wait up to `lockWaitMs` (default: the same 4/8/16 s by memory tier)
for an owner that is closing. `removeOpfsPool` removes the pool's OPFS directory (`.<pool>`).
If the browser refuses the OPFS root (Safari private browsing, Playwright's WebKit), both throw
`SqlStorageUnavailableError("opfs-unavailable")`, the same typed reason `openSqlDatabase` reports.

## Export and import (backup, or move to another device)

**TL;DR:** `exportDatabase(name)` gives you the database as a plain SQLite file.
`importDatabase(name, bytes, { expectedSchema })` checks that file, then replaces your database
with it in one transaction. If anything is wrong, nothing changes.

**Why:** a local-first app's export file is the user's only backup and only way to move to a
new device. A hand-written dump format drifts from the schema; the SQLite file cannot.

```ts
import {
	exportDatabase,
	importDatabase,
	SqlImportRejectedError,
} from "@gainratio/browser/sql";

const APP_ID = 0x414c4d41; // your app's 32-bit magic; set it once at schema creation:
// await db.exec(`PRAGMA application_id = ${APP_ID}; PRAGMA user_version = 3`);

// Export: Uint8Array of a real SQLite file (sqlite3_serialize). Opens the OPFS database
// under its owner lock, or pass an open `db` instead of the name.
const bytes = await exportDatabase("catalogue");
const file = new Blob([bytes], { type: "application/vnd.sqlite3" });

// Import, e.g. from <input type="file">:
try {
	const result = await importDatabase("catalogue", new Uint8Array(await picked.arrayBuffer()), {
		expectedSchema: {
			applicationId: APP_ID,
			userVersion: { min: 1, max: 3 },          // versions this build can migrate
			checks: ["SELECT count(*) = 1 FROM sqlite_schema WHERE name = 'products'"],
		},
	});
	console.log(`imported ${result.byteLength} bytes, schema v${result.userVersion}`);
} catch (error) {
	if (error instanceof SqlImportRejectedError) {
		// error.reason: "not-sqlite" | "corrupt" | "foreign-application"
		//   | "unsupported-version" | "unsafe-schema" | "check-failed" | "too-large"
		showError(error.reason); // the database is exactly as it was
	} else throw error;
}
```

What import does, in order:

1. **Validate in a private scratch connection** (never yours): the SQLite magic header, then
   `PRAGMA integrity_check`, then `application_id` / `user_version` against `expectedSchema`,
   then the schema text, then your `checks` (read-only: `query_only`, `trusted_schema = OFF`).
2. **Swap in one `BEGIN IMMEDIATE` transaction** on your connection: the bytes are attached
   as an in-memory schema, your objects are dropped, the file's objects are created and their
   rows copied (rowids kept), all before one `COMMIT`. A failure
   half-way (disk full, a module that is missing) rolls all of it back, and SQLite's rollback
   journal makes that hold across a crash. The pinned build has no `sqlite3_backup_*`, so this
   is the same job done in SQL.
3. **Serialized against writers.** By name, the database is opened on OPFS under the owner Web
   Lock, so no other tab or Worker can write until the import is done; if another context has
   it open, the import fails closed with `SqlStorageUnavailableError("pool-in-use")`. With an
   open `db`, the import is one request in that Worker's queue. It works on OPFS and on an
   in-memory database (`db.importDatabase(bytes)`); by name it never falls back to memory.

**The file is untrusted input.** The swap re-creates objects from the file's schema text, so
that text is checked first, and anything unexpected is refused as `"unsafe-schema"` (or
`"corrupt"`):

- every schema row must be exactly one `CREATE TABLE | INDEX | VIEW | TRIGGER | VIRTUAL TABLE`
  of that object, unqualified (no `TEMP`, no `main.`), with no comment in the head and no second
  statement (SQLite's own `sqlite3_complete` decides where a statement ends);
- **triggers and views are refused unless you pass `allowTriggersAndViews: true`**: they run
  SQL the file chose, on your connection, later. Only opt in for files you trust;
- virtual tables only from `virtualTableModules` (default `["fts5"]`), checked twice: by the
  statement grammar, and by SQLite itself in a connection that has every other module dropped;
- after an import the connection keeps `PRAGMA trusted_schema = OFF`, so imported views,
  triggers, defaults and indexes can only call innocuous functions. Calling one of your app's
  own SQL functions from them fails with "unsafe use of ..." instead of running it;
- a schema that only fails to load on your connection (for example a `STORED` generated column
  that calls one of your app's functions) is refused as `"corrupt"` before anything changes,
  and the connection is left working.

Not copied: `sqlite_stat*` (run `ANALYZE` if you use it). SQLite never drops `sqlite_sequence`, so
an empty one can remain after importing a file without `AUTOINCREMENT`. `vector_init(...)` is per connection:
call it again after an import, as after any reopen. Default size limit: 256 MiB (`maxBytes`).
`maxBytes` must be a positive integer; `NaN`, `Infinity`, `0` or a negative value throws
`RangeError` rather than switching the limit off.

### Schemas with triggers (e.g. an append-only audit table)

A schema that guards itself with triggers needs the opt-in on import, or the import is refused
as `"unsafe-schema"`. aml-filter's workstation database is one: two `BEFORE UPDATE` /
`BEFORE DELETE` triggers keep `match_events` append-only. Its own backups are trusted files,
so it passes the flag together with a strict `expectedSchema`:

```ts
await importDatabase("workstation", bytes, {
	allowTriggersAndViews: true, // the file's two triggers are ours: keep them
	expectedSchema: { applicationId: WORKSTATION_APP_ID, userVersion: { min: 1, max: 4 } },
});
```

The triggers are re-created and work after the import; `trusted_schema = OFF` still stops them
calling your app's own SQL functions. Do not pass the flag for files from people you do not
trust: their triggers would run their SQL on your connection.

### Secrets and settings belong to the app layer

This library moves the database and nothing else. An app that also needs settings and secrets
(API keys) in its export composes them around these bytes; almamesh does exactly this:

1. Keep settings **in** the database (a versioned row), so they travel with it.
2. Never store secrets in plaintext in the file. Encrypt them with a key derived from a
   user passphrase (WebCrypto PBKDF2 or Argon2, then AES-GCM) into a separate section.
3. Write one envelope: `{ format, version, sqlite: bytes, secrets: ciphertext }`, with a
   versioned header so older exports can be migrated.
4. On import, decrypt and validate **everything first** (wrong passphrase or tampered file =
   reject), call `importDatabase` with your `expectedSchema`, and only then write the secrets.

## Move a database out of a legacy opfs-sahpool

**TL;DR:** an app that used to run its own SQLite build (for example `@sqlite.org/sqlite-wasm`
with `installOpfsSAHPoolVfs({ name: "amlfilter-workstation" })`) moves that file into a
database this library owns with one call. Old tabs cannot write during the move, a crash the
old build left behind is recovered, and the old pool is deleted only if you ask.

```ts
import { migrateLegacySahPool } from "@gainratio/browser/sql";

const moved = await migrateLegacySahPool({
	fromPool: "amlfilter-workstation", // the old VFS name (OPFS directory ".amlfilter-workstation")
	fromFile: "/kyc.sqlite3",          // the file name the old build opened
	to: "workstation",                 // or an open db from openSqlDatabase
	removeLegacy: true,                // delete the old pool after the import commits
	importOptions: { allowTriggersAndViews: true, expectedSchema: { applicationId: APP_ID } },
});
switch (moved.status) {
	case "migrated": break;   // moved.recoveredJournal, moved.legacy: "removed" | "kept" | "shared"
	case "absent": break;     // no old pool or file: nothing to do (nothing was created)
	case "in-use": break;     // an old-build tab still has it open: ask the user to close it, retry
}
```

What it does, in the SQL Worker:

1. **Exclusive.** Takes the Web Lock `${fromPool}-owner` (or `lockName`), then installs the old
   pool, which opens every one of its OPFS sync access handles. If an old-build tab still holds
   them, that fails and you get `"in-use"` with nothing changed. While the migration holds the
   handles, an old-build tab cannot open the pool, so nothing writes mid-read.
2. **Recovered by SQLite.** If the old build crashed mid-write, the pool holds a torn database
   plus a hot rollback journal. `opfs-sahpool` always reports a reserved lock, so SQLite never
   treats a journal inside a sahpool as hot: opening the file there reads the torn pages. The
   migration therefore opens the database and its journal together through SQLite's `unix` VFS
   (in-memory files), where SQLite's own hot-journal rollback runs. The scratch copies are
   deleted afterwards. A `-wal` file is refused rather than migrated without its frames.
3. **Atomic.** The recovered file goes through `importDatabase` (validation, then one
   transaction), with your `importOptions`. The old pool is removed only with
   `removeLegacy: true` and only after that import committed. Removing an opfs-sahpool
   deletes every file in it, so the pool is removed only when it holds nothing but `fromFile`
   and its journal; if it holds other databases, nothing is deleted and `legacy` is
   `"shared"`. Without `removeLegacy`, `legacy` is `"kept"`.

The target must be on OPFS (it refuses to migrate into an in-memory fallback). A missing pool
is reported `"absent"` without creating one.

## Run your SQL tests in Node: `@gainratio/browser/sql/node`

`openNodeSqlDatabase({ name })` gives a test suite the same `SqlDatabase` API on the same
pinned SQLite build, in-process: same client, same Worker-side handler, every message
structured-cloned like `postMessage`. Each call opens a new, empty in-memory database with its
own wasm instance (as each browser database has its own Worker). OPFS-only calls such as
`migrateLegacySahPool` reject.

```ts
// workstation.test.ts (Vitest, Node environment)
import { openNodeSqlDatabase } from "@gainratio/browser/sql/node";

const db = await openNodeSqlDatabase({ name: "workstation-test" });
await db.exec(SCHEMA);
await expect(db.exec("UPDATE match_events SET at = 'x'")).rejects.toThrow(/append-only/);
await db.close();
```

## What it does not do

- It does not share one OPFS database between tabs. The second tab gets the typed status
  above. Multi-tab OPFS needs SQLite's `opfs`/`opfs-wl` VFS and a cross-origin-isolated page;
  the [state store](sqlite-state.md) uses that path.
- It does not ship JS callbacks into the Worker. An interactive transaction runs your
  callback on the page and sends each statement to the Worker inside one `BEGIN IMMEDIATE`.
- `query` and `prepare` compile one statement. Use `exec` for a multi-statement script.

## Proof

- `src/sql/engine.test.ts`: FTS5 `bm25()`, `vector_full_scan` and JSON1 on one connection,
  profile PRAGMAs applied, atomic rollback, against the shipped `sqlite3.wasm` in Node.
- `src/sql/client.test.ts`: every call round-trips through the Worker protocol
  (structured-cloned) to the real engine.
- `src/sql/open.test.ts`, `src/sql/opfsPool.test.ts`: fallback status, owner lock, idempotent removal.
- `src/sql/portable.test.ts`: export/import row for row (rowids, blobs, FTS5, AUTOINCREMENT,
  WITHOUT ROWID, views, triggers), every rejection, a disk-full failure half-way through the
  swap leaving the original intact, and the untrusted-schema guards.
- `src/sql/portableClient.test.ts`: the same through the Worker protocol, plus the owner lock:
  an import by name fails closed while another context owns the database, and a writer in
  another context waits until the import is done.
- `test/browser/sql-portable.spec.ts`: the real Worker on OPFS and in memory: round trip with
  FTS5 + vectors, typed rejections, and a second Worker blocked by the import's owner lock.
- `test/browser/sql-seam.spec.ts`: the real Worker in Chromium on OPFS — persistence across
  reopen, second-owner fallback, and pool removal.
- `src/sql/interactiveTransaction.test.ts`: interactive transactions through the real
  client and engine: commit, rollback on throw, on a failed statement and on a failed
  `COMMIT`, concurrent callers serialized (no lost update), other calls held until the end.
- `src/sql/legacy.test.ts`: hot-journal recovery on the real build (a crafted rollback journal
  over a torn file comes back as the committed file, byte for byte; scratch files removed),
  the lock / in-use / absent / WAL / removal-only-after-import rules, and a row-identical copy
  with the workstation's two triggers.
- `src/sql/node.test.ts`, `test/sql-node-consumer.test.ts`: the Node entry, and a consumer
  project that installs the `npm pack` tarball and runs SQL through `@gainratio/browser/sql/node`.
- `test/browser/sql-legacy.spec.ts` (Chromium, Firefox, WebKit): a real old-build sahpool
  crashed mid-write; reading through the sahpool sees the torn rows, an old tab holding the pool
  gives `"in-use"`, then the migration recovers all 2,000 rows exactly and removes the pool.
- `test/browser/cross-browser.spec.ts`: the same seam in Chromium, Firefox and WebKit — OPFS
  open (or, in Playwright's WebKit, the typed `opfs-unavailable` fallback), a SQL round trip,
  export/import, and the memory profile picked without `navigator.deviceMemory`.
