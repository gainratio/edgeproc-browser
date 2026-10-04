// @vitest-environment node
//
// db.transaction(async (tx) => …): a read, a JS decision and a write commit
// together. Driven through the real client, protocol and pinned SQLite build
// (the Node entry), so the lock and BEGIN IMMEDIATE … COMMIT are the real ones.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SqlDatabase } from "./client";
import { openNodeSqlDatabase } from "./node";

let db: SqlDatabase;

beforeEach(async () => {
	db = await openNodeSqlDatabase({ name: "accounts" });
	await db.exec(`
		CREATE TABLE accounts(id TEXT PRIMARY KEY, balance INTEGER NOT NULL);
		INSERT INTO accounts VALUES ('alice', 100), ('bob', 0);
	`);
});

afterEach(async () => {
	await db.close();
});

const balances = () =>
	db.query<{ id: string; balance: number }>(
		"SELECT id, balance FROM accounts ORDER BY id",
	);

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Move `amount` from alice to bob if she can afford it — read, decide, write. */
async function transfer(amount: number, pause?: Promise<void>) {
	return db.transaction(async (tx) => {
		const [alice] = await tx.query<{ balance: number }>(
			"SELECT balance FROM accounts WHERE id = 'alice'",
		);
		await pause;
		if ((alice?.balance ?? 0) < amount) throw new Error("insufficient funds");
		await tx.exec(
			"UPDATE accounts SET balance = balance - ? WHERE id = 'alice'",
			[amount],
		);
		await tx.exec(
			"UPDATE accounts SET balance = balance + ? WHERE id = 'bob'",
			[amount],
		);
		return amount;
	});
}

describe("db.transaction(async (tx) => …)", () => {
	it("commits the reads and writes together and returns the callback's value", async () => {
		expect(await transfer(30)).toBe(30);
		expect(await balances()).toEqual([
			{ id: "alice", balance: 70 },
			{ id: "bob", balance: 30 },
		]);
	});

	it("rolls back every write when the callback throws, and rethrows that error", async () => {
		const boom = new Error("boom");
		await expect(
			db.transaction(async (tx) => {
				await tx.exec("UPDATE accounts SET balance = 0");
				await tx.exec("INSERT INTO accounts VALUES ('carol', 5)");
				throw boom;
			}),
		).rejects.toBe(boom);
		expect(await balances()).toEqual([
			{ id: "alice", balance: 100 },
			{ id: "bob", balance: 0 },
		]);
	});

	it("rolls back when a statement inside fails", async () => {
		await expect(
			db.transaction(async (tx) => {
				await tx.exec("UPDATE accounts SET balance = 1 WHERE id = 'alice'");
				await tx.exec("INSERT INTO accounts VALUES ('alice', 1)");
			}),
		).rejects.toThrow(/UNIQUE constraint failed/);
		expect((await balances())[0]).toEqual({ id: "alice", balance: 100 });
	});

	it("rolls back when COMMIT itself fails (a deferred foreign key)", async () => {
		await db.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE notes(account TEXT REFERENCES accounts(id) DEFERRABLE INITIALLY DEFERRED);
		`);
		await expect(
			db.transaction(async (tx) => {
				await tx.exec("INSERT INTO notes VALUES ('nobody')");
				await tx.exec("UPDATE accounts SET balance = 0");
			}),
		).rejects.toThrow(/FOREIGN KEY constraint failed/);
		expect((await balances())[0]).toEqual({ id: "alice", balance: 100 });
		expect(await db.query("SELECT count(*) AS n FROM notes")).toEqual([
			{ n: 0 },
		]);
		// The connection is out of the transaction: a new one can begin.
		expect(await transfer(10)).toBe(10);
	});

	it("serializes concurrent callers: no lost update, no nested BEGIN", async () => {
		const gate = deferred();
		const first = transfer(60, gate.promise);
		const second = transfer(60);
		gate.resolve();
		const outcome = await Promise.allSettled([first, second]);
		expect(outcome[0]).toEqual({ status: "fulfilled", value: 60 });
		// The second read happened after the first committed: 40 < 60.
		expect(outcome[1]).toMatchObject({
			status: "rejected",
			reason: { message: "insufficient funds" },
		});
		expect(await balances()).toEqual([
			{ id: "alice", balance: 40 },
			{ id: "bob", balance: 60 },
		]);
	});

	it("holds other callers' statements until the transaction ends", async () => {
		const gate = deferred();
		const order: string[] = [];
		const before = db.query("SELECT 1").then(() => order.push("before"));
		const tx = db.transaction(async (t) => {
			await t.exec("UPDATE accounts SET balance = 0 WHERE id = 'alice'");
			order.push("tx wrote");
			await gate.promise;
			order.push("tx done");
		});
		const outside = db
			.query<{ balance: number }>(
				"SELECT balance FROM accounts WHERE id = 'alice'",
			)
			.then((rows) => {
				order.push(`outside saw ${rows[0]?.balance}`);
			});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(order).toEqual(["before", "tx wrote"]);
		gate.resolve();
		await Promise.all([before, tx, outside]);
		expect(order).toEqual(["before", "tx wrote", "tx done", "outside saw 0"]);
	});

	it("keeps the arguments a held call was made with", async () => {
		const gate = deferred();
		const tx = db.transaction(async () => {
			await gate.promise;
		});
		const bind: [string, number] = ["carol", 7];
		const held = db.exec("INSERT INTO accounts VALUES (?, ?)", bind);
		bind[1] = 999;
		gate.resolve();
		await Promise.all([tx, held]);
		expect(
			await db.query("SELECT balance FROM accounts WHERE id = 'carol'"),
		).toEqual([{ balance: 7 }]);
	});

	it("does not mask the callback's error when SQLite already ended the transaction", async () => {
		await expect(
			db.transaction(async (tx) => {
				await tx.exec("ROLLBACK");
				throw new Error("after manual rollback");
			}),
		).rejects.toThrow("after manual rollback");
		expect(await transfer(1)).toBe(1);
	});

	it("refuses a tx handle used after its callback returned", async () => {
		let escaped:
			| Parameters<Parameters<SqlDatabase["transaction"]>[0]>[0]
			| undefined;
		await db.transaction(async (tx) => {
			escaped = tx;
		});
		await expect(escaped?.query("SELECT 1")).rejects.toThrow(
			/transaction has ended/,
		);
	});

	it("keeps the statement-list form", async () => {
		const result = await db.transaction([
			{ sql: "UPDATE accounts SET balance = balance + 1" },
			{ sql: "SELECT sum(balance) AS total FROM accounts" },
		]);
		expect(result).toEqual({ changes: 2, results: [[], [{ total: 102 }]] });
	});

	it("waits for an open transaction before closing", async () => {
		const gate = deferred();
		const tx = transfer(5, gate.promise);
		const closing = db.close();
		gate.resolve();
		await expect(tx).resolves.toBe(5);
		await closing;
		await expect(db.query("SELECT 1")).rejects.toThrow(/closed/);
		db = await openNodeSqlDatabase({ name: "accounts" });
	});
});
