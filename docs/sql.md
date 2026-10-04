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
	executeMany(sql, rows): Promise<SqlExecResult>;      // bulk load, one transaction
	prepare(sql): Promise<SqlPreparedStatement>;         // run(bind?) / all(bind?) / finalize()
	exportDatabase(): Promise<Uint8Array>;              // the whole database as a SQLite file
	importDatabase(bytes, options?): Promise<SqlImportResult>; // validate, then replace atomically
	runtimeInfo(): Promise<SqlRuntimeInfo>;              // versions, fts5, json1, profile, storage
	close(): Promise<void>;
}

exportDatabase(db | name, { workerFactory? }?): Promise<Uint8Array>
importDatabase(db | name, bytes, options?): Promise<SqlImportResult>

removeSqlDatabase(name): Promise<"removed" | "absent" | "in-use">
removeOpfsPool(poolName): Promise<"removed" | "absent" | "in-use">
sqliteVectorPoolName(name): Promise<string>   // pool used by createSqliteVectorIndex
sqlDatabasePoolName(name): Promise<string>    // pool used by openSqlDatabase
```

`bind` is positional (`[1, "a"]`) or named (`{ ":id": 1 }`). In `transaction`, a statement is
`{ sql, bind? }` or `{ sql, rows }` (executemany). Any failure rolls back the whole transaction.

## Storage status and the in-memory fallback

The database lives in its own `opfs-sahpool` VFS. That VFS holds exclusive OPFS handles, so
only one tab can own it. The Worker takes an exclusive Web Lock for the life of the
connection and waits up to 2 seconds for a previous owner (a reload) before giving up.

| `db.storage` | Meaning |
|---|---|
| `{ persistence: "opfs", pool, file }` | On disk. SQLite's page cache and heap limits come from the memory profile. |
| `{ persistence: "memory", reason: "pool-in-use" }` | Another tab owns this database. You asked for `fallback: "memory"`. |
| `{ persistence: "memory", reason: "opfs-unavailable", detail }` | OPFS failed (private browsing, old browser). You asked for `fallback: "memory"`. |
| `{ persistence: "memory", reason: "requested" }` | You passed `persistence: "memory"`. |

Without `fallback: "memory"`, both failures throw `SqlStorageUnavailableError` with the same
`reason`. Only allow the fallback for small data you rebuild on every boot: an in-memory
database holds everything in the wasm heap, which is how iPhones run out of memory.

On OPFS the Worker also sets `PRAGMA secure_delete = ON` and `journal_mode = DELETE`, and
checks they stuck.

## Delete an old database or pool

Removal is idempotent. It returns `"absent"` when there is nothing to delete and `"in-use"`
(deleting nothing) while another context has the files open.

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

`removeSqlDatabase` takes the same owner lock as `openSqlDatabase`, so it never deletes a
database this origin has open. `removeOpfsPool` removes the pool's OPFS directory (`.<pool>`).

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
  triggers, defaults and indexes can only call innocuous functions.

Not copied: `sqlite_stat*` (run `ANALYZE` if you use it). SQLite never drops `sqlite_sequence`, so
an empty one can remain after importing a file without `AUTOINCREMENT`. `vector_init(...)` is per connection:
call it again after an import, as after any reopen. Default size limit: 256 MiB (`maxBytes`).

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

## What it does not do

- It does not share one OPFS database between tabs. The second tab gets the typed status
  above. Multi-tab OPFS needs SQLite's `opfs`/`opfs-wl` VFS and a cross-origin-isolated page;
  the [state store](sqlite-state.md) uses that path.
- It does not ship JS callbacks into the Worker. A transaction is a list of statements.
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
