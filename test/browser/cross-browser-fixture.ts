// The same proof in Chromium, Firefox and WebKit: OPFS open (or the typed
// reason it was refused), the memory fallback and its storage status, a SQL
// round trip through the library's Worker, export/import, and the memory
// profile the Worker picked from this browser's navigator signals.

import {
	exportDatabase,
	importDatabase,
	openSqlDatabase,
	removeSqlDatabase,
	SqlImportRejectedError,
	type SqlStorage,
	SqlStorageUnavailableError,
} from "@gainratio/browser/sql";
import {
	currentMemoryEnvironment,
	detectMemoryTier,
} from "@gainratio/browser/sqlite";

export interface CrossBrowserProof {
	/** openSqlDatabase with the default fallback "none": opened, or the typed refusal. */
	readonly strictOpen: SqlStorage | { readonly refused: string };
	/** The same name with fallback "memory". */
	readonly fallbackStorage: SqlStorage;
	/** A second open while the first holds the pool, fallback "memory". */
	readonly secondTab: SqlStorage;
	readonly requested: SqlStorage;
	readonly rows: unknown;
	readonly fts: unknown;
	readonly reopenedRows: unknown;
	readonly exportHeader: string;
	readonly importedRows: unknown;
	readonly corrupt: string;
	readonly deviceMemoryType: string;
	readonly detectedTier: string;
	readonly workerTier: string;
	readonly removals: ReadonlyArray<string>;
}

declare global {
	interface Window {
		runCrossBrowserProof(name: string): Promise<CrossBrowserProof>;
	}
}

type Db = Awaited<ReturnType<typeof openSqlDatabase>>;

function reasonOf(error: unknown): string {
	if (error instanceof SqlImportRejectedError) return error.reason;
	if (error instanceof SqlStorageUnavailableError) return error.reason;
	return String(error);
}

/** removeSqlDatabase's result, or the typed reason it refused. */
const removal = (name: string) =>
	removeSqlDatabase(name).then(
		String,
		(error: unknown) => `refused:${reasonOf(error)}`,
	);

async function strictOpen(name: string) {
	try {
		const db = await openSqlDatabase({ name });
		const storage = db.storage;
		await db.close();
		return storage;
	} catch (error) {
		return { refused: reasonOf(error) };
	}
}

async function seed(db: Db) {
	await db.exec(`
		CREATE TABLE products(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
		CREATE VIRTUAL TABLE products_fts USING fts5(title, content='products', content_rowid='id');
	`);
	await db.transaction([
		{
			sql: "INSERT INTO products VALUES (?, ?)",
			rows: [
				[1, "red running shoes"],
				[2, "blue rain jacket"],
				[3, "red wool scarf"],
			],
		},
		{ sql: "INSERT INTO products_fts(products_fts) VALUES ('rebuild')" },
	]);
}

const allRows = (db: Db) =>
	db.query("SELECT id, title FROM products ORDER BY id");

async function portable(db: Db, name: string) {
	const bytes = await exportDatabase(db);
	const target = await openSqlDatabase({
		name: `${name}-import`,
		persistence: "memory",
	});
	await importDatabase(target, bytes);
	const importedRows = await allRows(target);
	const damaged = bytes.slice();
	damaged.fill(0xff, 100, bytes.byteLength);
	const corrupt = await importDatabase(target, damaged).then(
		() => "accepted",
		reasonOf,
	);
	await target.close();
	return {
		exportHeader: new TextDecoder().decode(bytes.subarray(0, 15)),
		importedRows,
		corrupt,
	};
}

window.runCrossBrowserProof = async (name): Promise<CrossBrowserProof> => {
	const strict = await strictOpen(name);
	const db = await openSqlDatabase({ name, fallback: "memory" });
	await seed(db);
	const rows = await allRows(db);
	const fts = await db.query(
		"SELECT rowid AS id FROM products_fts WHERE products_fts MATCH 'red' ORDER BY rowid",
	);
	const second = await openSqlDatabase({ name, fallback: "memory" });
	const secondTab = second.storage;
	await second.close();
	const info = await db.runtimeInfo();
	const moved = await portable(db, name);
	await db.close();

	const reopened = await openSqlDatabase({ name, fallback: "memory" });
	const [count] = await reopened.query(
		"SELECT count(*) AS n FROM sqlite_schema WHERE name = 'products'",
	);
	await reopened.close();

	const requestedDb = await openSqlDatabase({
		name: `${name}-scratch`,
		persistence: "memory",
	});
	const requested = requestedDb.storage;
	await requestedDb.close();

	const env = currentMemoryEnvironment();
	return {
		strictOpen: strict,
		fallbackStorage: info.storage,
		secondTab,
		requested,
		rows,
		fts: fts.map((row) => row.id),
		reopenedRows: count?.n,
		...moved,
		deviceMemoryType: typeof env.deviceMemory,
		detectedTier: detectMemoryTier(env),
		workerTier: info.memoryProfile.tier,
		removals: [await removal(name), await removal(name)],
	};
};
