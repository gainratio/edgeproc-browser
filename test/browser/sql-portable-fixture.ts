// Real-browser proof of SQLite export/import: the library's Worker, OPFS via
// opfs-sahpool, the owner Web Lock, and the in-memory database.
import {
	exportDatabase,
	importDatabase,
	openSqlDatabase,
	removeSqlDatabase,
	SqlImportRejectedError,
	SqlStorageUnavailableError,
	sqlDatabasePoolName,
} from "@gainratio/browser/sql";

export interface SqlPortableProof {
	readonly exportHeader: string;
	readonly sourceRows: unknown;
	readonly importedRows: unknown;
	readonly importedHybrid: unknown;
	readonly corrupt: string;
	readonly foreign: string;
	readonly whileHeld: string;
	readonly heldRowsAfter: unknown;
	readonly events: ReadonlyArray<string>;
	readonly writerRows: unknown;
	readonly memoryStorage: string;
	readonly memoryRows: unknown;
	readonly trustedSchema: unknown;
}

declare global {
	interface Window {
		runSqlPortableProof(name: string): Promise<SqlPortableProof>;
	}
}

const APP_ID = 0x45444745;

function reasonOf(error: unknown): string {
	if (error instanceof SqlImportRejectedError) return error.reason;
	if (error instanceof SqlStorageUnavailableError) return error.reason;
	return String(error);
}

async function hybrid(db: Awaited<ReturnType<typeof openSqlDatabase>>) {
	await db.query(
		"SELECT vector_init('products', 'embedding', 'type=FLOAT32,dimension=3')",
	);
	const rows = await db.query(
		`WITH kw AS (SELECT rowid AS id FROM products_fts WHERE products_fts MATCH :q),
		      knn AS (SELECT rowid AS id, distance FROM vector_full_scan('products', 'embedding', :v, 3))
		 SELECT p.title FROM knn JOIN kw USING (id) JOIN products p ON p.id = knn.id ORDER BY knn.distance`,
		{ ":q": "red", ":v": new Float32Array([1, 0, 0]) },
	);
	return rows.map((row) => row.title);
}

window.runSqlPortableProof = async (name): Promise<SqlPortableProof> => {
	const [src, dst, mem] = [`${name}-src`, `${name}-dst`, `${name}-mem`];
	const source = await openSqlDatabase({ name: src });
	await source.exec(`
		PRAGMA application_id = ${APP_ID};
		PRAGMA user_version = 2;
		CREATE TABLE products(id INTEGER PRIMARY KEY, title TEXT NOT NULL, embedding BLOB, pad BLOB);
		CREATE VIRTUAL TABLE products_fts USING fts5(title, content='products', content_rowid='id');
	`);
	await source.transaction([
		{
			sql: "INSERT INTO products VALUES (?, ?, ?, randomblob(20000))",
			rows: [
				[1, "red running shoes", new Float32Array([1, 0, 0])],
				[2, "blue rain jacket", new Float32Array([0, 1, 0])],
				[3, "red wool scarf", new Float32Array([0.9, 0.1, 0])],
			],
		},
		// Bulk so the import takes long enough to observe its lock.
		{
			sql: "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200) INSERT INTO products(title, pad) SELECT 'filler ' || i, randomblob(20000) FROM n",
		},
		{ sql: "INSERT INTO products_fts(products_fts) VALUES ('rebuild')" },
	]);
	const sourceRows = await source.query(
		"SELECT id, title, embedding, hex(pad) AS pad FROM products ORDER BY id",
	);
	const bytes = await exportDatabase(source);
	const exportHeader = new TextDecoder().decode(bytes.subarray(0, 15));

	const corruptBytes = bytes.slice();
	// Smash the start of every page after the schema page: b-tree headers,
	// cell pointers and overflow-chain links.
	for (let at = 4096; at < corruptBytes.byteLength; at += 4096) {
		corruptBytes.fill(0xa5, at, at + 64);
	}
	const corrupt = await source
		.importDatabase(corruptBytes)
		.then(() => "accepted", reasonOf);
	const foreign = await source
		.importDatabase(bytes, { expectedSchema: { applicationId: APP_ID + 1 } })
		.then(() => "accepted", reasonOf);
	// `source` holds the owner lock: an import by name must not touch it.
	const whileHeld = await importDatabase(src, new Uint8Array(bytes)).then(
		() => "accepted",
		reasonOf,
	);
	const [heldRowsAfter] = await source.query(
		"SELECT count(*) AS n FROM products",
	);
	await source.close();

	await importDatabase(dst, bytes, {
		expectedSchema: { applicationId: APP_ID, userVersion: { min: 1, max: 2 } },
	});
	const imported = await openSqlDatabase({ name: dst });
	const importedRows = await imported.query(
		"SELECT id, title, embedding, hex(pad) AS pad FROM products ORDER BY id",
	);
	const importedHybrid = await hybrid(imported);
	await imported.close();

	// A writer in another Worker while an import by name runs: it waits for
	// the owner lock, then writes ON TOP of the imported data.
	const events: string[] = [];
	const ownerLock = `${await sqlDatabasePoolName(dst)}-owner`;
	const importing = importDatabase(dst, bytes).then(() =>
		events.push("import done"),
	);
	for (let spins = 0; spins < 10_000; spins++) {
		const state = await navigator.locks.query();
		if (state.held?.some((lock) => lock.name === ownerLock)) break;
	}
	events.push("import holds lock");
	// The writer waits out the whole import (Worker boot, wasm, validation,
	// swap): ~0.5 s on a fast laptop, over the 1 s "full"-tier owner-lock
	// budget on a 2-core CI runner. The "minimal" tier's 4 s budget keeps this
	// a proof of serialization, not a race against runner speed.
	const writer = await openSqlDatabase({ name: dst, memoryProfile: "minimal" });
	events.push("writer opened");
	await writer.exec(
		"INSERT INTO products(id, title) VALUES (9999, 'after import')",
	);
	await importing;
	const [writerRows] = await writer.query(
		"SELECT count(*) AS n, max(id) AS top FROM products",
	);
	await writer.close();

	const memory = await openSqlDatabase({ name: mem, persistence: "memory" });
	await memory.importDatabase(await exportDatabase(dst));
	const memoryRows = await memory.query(
		"SELECT id, title, embedding, hex(pad) AS pad FROM products WHERE id < 9999 ORDER BY id",
	);
	const [trusted] = await memory.query("PRAGMA trusted_schema");
	const memoryStorage = memory.storage.persistence;
	await memory.close();

	await removeSqlDatabase(src);
	await removeSqlDatabase(dst);
	return {
		exportHeader,
		sourceRows,
		importedRows,
		importedHybrid,
		corrupt,
		foreign,
		whileHeld,
		heldRowsAfter: heldRowsAfter?.n,
		events,
		writerRows,
		memoryStorage,
		memoryRows,
		trustedSchema: trusted?.trusted_schema,
	};
};
