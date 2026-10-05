// @vitest-environment node
// The vector index's pool is topped up before its file is opened: a pool left
// with one slot (no room for a journal) still takes a write transaction.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installMemoryOpfs } from "../../sql/__fixtures__/memoryOpfs";
import { loadNodeSqlite } from "../../sql/__fixtures__/nodeSqlite";
import {
	shrinkToOneSlot,
	slotCount,
} from "../../sql/__fixtures__/sahPoolSlots";
import { installSahPool } from "../../sql/sahPool";
import { openOwnedDatabase } from "./poolOwner";

let uninstall: () => void = () => undefined;

beforeAll(() => {
	uninstall = installMemoryOpfs();
});

afterAll(() => {
	uninstall();
});

describe("openOwnedDatabase (vector index pool)", () => {
	it("tops a one-slot pool up so the index's journal can be created", async () => {
		const sqlite = await loadNodeSqlite();
		const pool = "edgeproc-vector-short";
		await shrinkToOneSlot(await installSahPool(sqlite.module, pool));
		const opened = await openOwnedDatabase(
			undefined,
			pool,
			1_000,
			"memory",
			() => installSahPool(sqlite.module, pool),
		);
		try {
			opened.raw.exec({
				sql: "CREATE TABLE t(x INTEGER); BEGIN IMMEDIATE; INSERT INTO t VALUES (1); COMMIT;",
			});
			expect(await slotCount(pool)).toBe(2);
		} finally {
			opened.raw.close();
			await opened.release();
		}
	});
});
