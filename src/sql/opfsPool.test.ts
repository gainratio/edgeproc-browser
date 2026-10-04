import { describe, expect, it } from "vitest";
import { openSqlStorage, sqlDatabasePoolName } from "./open";
import {
	type OpfsRoot,
	removeOpfsPool,
	removeSqlDatabase,
	sqliteVectorPoolName,
} from "./opfsPool";

function domError(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

/** OPFS root model: top-level entries, some pinned open by a live handle. */
class FakeRoot implements OpfsRoot {
	readonly entries = new Set<string>();
	readonly open = new Set<string>();
	readonly calls: Array<{ name: string; recursive: boolean | undefined }> = [];
	failure: Error | undefined;

	public async removeEntry(
		name: string,
		options?: { recursive?: boolean },
	): Promise<void> {
		this.calls.push({ name, recursive: options?.recursive });
		if (this.failure !== undefined) throw this.failure;
		if (!this.entries.has(name)) throw domError("NotFoundError");
		if (this.open.has(name)) throw domError("NoModificationAllowedError");
		this.entries.delete(name);
	}
}

describe("removeOpfsPool", () => {
	it("removes a pool's whole directory, then reports it absent (idempotent)", async () => {
		const root = new FakeRoot();
		root.entries.add(".edgereco-catalogue");
		root.entries.add(".keep-me");
		expect(await removeOpfsPool("edgereco-catalogue", { root })).toBe(
			"removed",
		);
		expect(root.calls[0]).toEqual({
			name: ".edgereco-catalogue",
			recursive: true,
		});
		expect(await removeOpfsPool("edgereco-catalogue", { root })).toBe("absent");
		expect([...root.entries]).toEqual([".keep-me"]);
	});

	it("reports in-use, deleting nothing, while another context holds the pool", async () => {
		const root = new FakeRoot();
		root.entries.add(".busy");
		root.open.add(".busy");
		expect(await removeOpfsPool("busy", { root })).toBe("in-use");
		expect(root.entries.has(".busy")).toBe(true);
	});

	it("rethrows anything it cannot classify", async () => {
		const root = new FakeRoot();
		root.failure = domError("SecurityError");
		await expect(removeOpfsPool("pool", { root })).rejects.toThrow(
			/SecurityError/,
		);
	});

	it.each(["", ".", "..", "a/b", ".hidden", "a\\b"])(
		"refuses the unsafe pool name %j",
		async (name) => {
			const root = new FakeRoot();
			await expect(removeOpfsPool(name, { root })).rejects.toThrow(
				/invalid OPFS pool name/,
			);
			expect(root.calls).toEqual([]);
		},
	);

	it("maps names to the pools the library creates", async () => {
		expect(await sqliteVectorPoolName("catalog")).toMatch(
			/^edgeproc-vector-[0-9a-f]{32}$/,
		);
		expect(await sqliteVectorPoolName("catalog")).not.toBe(
			await sqliteVectorPoolName("other"),
		);
	});
});

describe("removeSqlDatabase", () => {
	it("deletes a closed database's pool and is idempotent", async () => {
		const root = new FakeRoot();
		const pool = await sqlDatabasePoolName("old");
		root.entries.add(`.${pool}`);
		expect(await removeSqlDatabase("old", { root, locks: undefined })).toBe(
			"removed",
		);
		expect(await removeSqlDatabase("old", { root, locks: undefined })).toBe(
			"absent",
		);
	});

	it("refuses while this origin has the database open (owner lock held)", async () => {
		const root = new FakeRoot();
		const pool = await sqlDatabasePoolName("live");
		root.entries.add(`.${pool}`);
		const locks = navigatorLikeLocks();
		const owner = await openSqlStorage(
			{
				openMemory: () => ({}),
				installPool: async () => ({ OpfsSAHPoolDb: class {} }),
				locks,
				warn: () => undefined,
				lockWaitMs: 10,
			},
			{ name: "live" },
		);
		expect(await removeSqlDatabase("live", { root, locks })).toBe("in-use");
		expect(root.calls).toEqual([]);
		owner.release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await removeSqlDatabase("live", { root, locks })).toBe("removed");
	});
});

/** Minimal exclusive Web Locks with ifAvailable support. */
function navigatorLikeLocks() {
	const held = new Set<string>();
	return {
		async request<T>(
			name: string,
			options: {
				readonly ifAvailable?: boolean;
				readonly signal?: AbortSignal;
			},
			callback: (lock: unknown) => Promise<T>,
		): Promise<T> {
			if (held.has(name)) {
				if (options.ifAvailable === true) return callback(null);
				throw domError("AbortError");
			}
			held.add(name);
			try {
				return await callback({ name });
			} finally {
				held.delete(name);
			}
		},
	};
}
