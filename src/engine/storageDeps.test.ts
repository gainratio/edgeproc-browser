// @vitest-environment node
// The engine's chunk-cache pool (the one that ran out of slots in almamesh
// CI) is topped up for its memory tier: a pool left with one slot is grown
// to 6 on "minimal" (temp_store=FILE) and to exactly the database and its
// journal on "full" and "lite" (temp_store=MEMORY).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installMemoryOpfs } from "../sql/__fixtures__/memoryOpfs";
import { loadNodeSqlite } from "../sql/__fixtures__/nodeSqlite";
import { shrinkToOneSlot, slotCount } from "../sql/__fixtures__/sahPoolSlots";
import { openSqlStorage, sqlDatabasePoolName } from "../sql/open";
import { installSahPool } from "../sql/sahPool";
import { MEMORY_PROFILES, type MemoryTier } from "../sqlite/memoryProfile";
import { chunkDatabaseName } from "./chunkDatabase";
import { engineStorageDeps } from "./storageDeps";

let uninstall: () => void = () => undefined;

beforeAll(() => {
	uninstall = installMemoryOpfs();
});

afterAll(() => {
	uninstall();
});

async function slotsAfterOpen(tier: MemoryTier): Promise<number> {
	const sqlite = await loadNodeSqlite();
	const name = chunkDatabaseName(`shop-${tier}`);
	const pool = await sqlDatabasePoolName(name);
	await shrinkToOneSlot(await installSahPool(sqlite.module, pool));
	const opened = await openSqlStorage(
		engineStorageDeps(sqlite.module, MEMORY_PROFILES[tier]),
		{ name },
	);
	try {
		expect(opened.storage.persistence).toBe("opfs");
		return await slotCount(pool);
	} finally {
		(opened.raw as unknown as { close(): void }).close();
		await opened.release();
	}
}

describe("engineStorageDeps: the chunk-cache pool's slots by memory tier", () => {
	it("tops a one-slot pool up to 6 on the minimal tier", async () => {
		expect(await slotsAfterOpen("minimal")).toBe(6);
	});

	it("tops a one-slot pool up to the database and its journal on full and lite", async () => {
		expect(await slotsAfterOpen("full")).toBe(2);
		expect(await slotsAfterOpen("lite")).toBe(2);
	});
});
