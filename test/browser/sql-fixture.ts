// Real-browser proof of the public SQL seam: the library's own Worker, OPFS
// via opfs-sahpool, FTS5 + sqlite-vector on one connection, the memory
// profile, the typed fallback status and idempotent pool removal.
import {
	openSqlDatabase,
	removeOpfsPool,
	removeSqlDatabase,
	type SqlStorage,
	SqlStorageUnavailableError,
	sqliteVectorPoolName,
} from "@gainratio/browser/sql";
import { createSqliteVectorIndex } from "@gainratio/browser/vector/sqlite";

export interface SqlSeamProof {
	readonly storage: SqlStorage;
	readonly runtime: {
		readonly sqliteVersion: string;
		readonly vectorVersion: string;
		readonly fts5: boolean;
		readonly json1: boolean;
	};
	readonly profileApplied: boolean;
	readonly journalMode: unknown;
	readonly hybrid: ReadonlyArray<unknown>;
	readonly secondTab: SqlStorage;
	readonly secondTabRefusal: string;
	readonly removeWhileOpen: string;
	readonly reopenedStorage: string;
	readonly reopenedRows: unknown;
	readonly removals: ReadonlyArray<string>;
	readonly vectorPoolRemovals: ReadonlyArray<string>;
}

declare global {
	interface Window {
		runSqlSeamProof(name: string): Promise<SqlSeamProof>;
	}
}

window.runSqlSeamProof = async (name): Promise<SqlSeamProof> => {
	const db = await openSqlDatabase({ name });
	const info = await db.runtimeInfo();
	const [cache] = await db.query("PRAGMA cache_size");
	const [journal] = await db.query("PRAGMA journal_mode");
	await db.exec(`
		CREATE TABLE products(id INTEGER PRIMARY KEY, title TEXT NOT NULL, embedding BLOB);
		CREATE VIRTUAL TABLE products_fts USING fts5(title, content='products', content_rowid='id');
	`);
	await db.transaction([
		{
			sql: "INSERT INTO products VALUES (?, ?, ?)",
			rows: [
				[1, "red running shoes", new Float32Array([1, 0, 0])],
				[2, "blue rain jacket", new Float32Array([0, 1, 0])],
				[3, "red wool scarf", new Float32Array([0.9, 0.1, 0])],
			],
		},
		{ sql: "INSERT INTO products_fts(products_fts) VALUES ('rebuild')" },
	]);
	await db.query(
		"SELECT vector_init('products', 'embedding', 'type=FLOAT32,dimension=3')",
	);
	const hybrid = await db.query(
		`WITH kw AS (SELECT rowid AS id, bm25(products_fts) AS bm25 FROM products_fts WHERE products_fts MATCH :q),
		      knn AS (SELECT rowid AS id, distance FROM vector_full_scan('products', 'embedding', :v, 3))
		 SELECT p.title FROM knn JOIN kw USING (id) JOIN products p ON p.id = knn.id ORDER BY knn.distance`,
		{ ":q": "red", ":v": new Float32Array([1, 0, 0]) },
	);

	const second = await openSqlDatabase({ name, fallback: "memory" });
	const secondTab = second.storage;
	await second.close();
	const secondTabRefusal = await openSqlDatabase({ name }).then(
		async (unexpected) => {
			await unexpected.close();
			return "opened";
		},
		(error: unknown) =>
			error instanceof SqlStorageUnavailableError
				? error.reason
				: String(error),
	);
	const removeWhileOpen = await removeSqlDatabase(name);
	await db.close();

	const reopened = await openSqlDatabase({ name });
	const [count] = await reopened.query("SELECT count(*) AS n FROM products");
	const reopenedStorage = reopened.storage.persistence;
	await reopened.close();
	const removals = [
		await removeSqlDatabase(name),
		await removeSqlDatabase(name),
	];

	const vectorName = `${name}-vectors`;
	const vectors = await createSqliteVectorIndex({
		name: vectorName,
		dimension: 2,
		persistence: "opfs",
	});
	await vectors.dispose();
	const pool = await sqliteVectorPoolName(vectorName);
	const vectorPoolRemovals = [
		await removeOpfsPool(pool),
		await removeOpfsPool(pool),
	];

	return {
		storage: info.storage,
		runtime: {
			sqliteVersion: info.sqliteVersion,
			vectorVersion: info.vectorVersion,
			fts5: info.fts5,
			json1: info.json1,
		},
		profileApplied: cache?.cache_size === -info.memoryProfile.cacheSizeKiB,
		journalMode: journal?.journal_mode,
		hybrid: hybrid.map((row) => row.title),
		secondTab,
		secondTabRefusal,
		removeWhileOpen,
		reopenedStorage,
		reopenedRows: count?.n,
		removals,
		vectorPoolRemovals,
	};
};
