import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryProfile } from "../sqlite/memoryProfile";
import { FakeLocks } from "./__fixtures__/fakeLocks";
import { openSqlStorage, ownerLockWaitMs, sqlDatabasePoolName } from "./open";
import {
	type OpfsRoot,
	removeOpfsPool,
	removeSqlDatabase,
	sqliteVectorPoolName,
} from "./opfsPool";
import { SqlStorageUnavailableError } from "./types";

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

	it("reports in-use for InvalidModificationError as well", async () => {
		const root = new FakeRoot();
		root.failure = domError("InvalidModificationError");
		expect(await removeOpfsPool("busy", { root })).toBe("in-use");
	});

	it("waits for the pool's owner lock, then removes (a closing owner is not in-use)", async () => {
		const root = new FakeRoot();
		root.entries.add(".closing");
		const locks = new FakeLocks();
		let releaseOwner: () => void = () => undefined;
		void locks.request(
			"closing-owner",
			{},
			() => new Promise<void>((resolve) => (releaseOwner = resolve)),
		);
		const removing = removeOpfsPool("closing", {
			root,
			locks,
			lockWaitMs: 1_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(root.calls).toEqual([]);
		releaseOwner();
		expect(await removing).toBe("removed");
		expect(locks.isHeld("closing-owner")).toBe(false);
	});

	it("deletes while holding the owner lock, so no one can reopen mid-delete", async () => {
		const locks = new FakeLocks();
		const heldDuringDelete: boolean[] = [];
		const root: OpfsRoot = {
			removeEntry: async () => {
				heldDuringDelete.push(locks.isHeld("guarded-owner"));
			},
		};
		expect(await removeOpfsPool("guarded", { root, locks })).toBe("removed");
		expect(heldDuringDelete).toEqual([true]);
	});

	it("reports in-use, touching nothing, when the owner keeps the lock past the bounded wait", async () => {
		const root = new FakeRoot();
		root.entries.add(".owned");
		const locks = new FakeLocks();
		let releaseOwner: () => void = () => undefined;
		void locks.request(
			"owned-owner",
			{},
			() => new Promise<void>((resolve) => (releaseOwner = resolve)),
		);
		expect(await removeOpfsPool("owned", { root, locks, lockWaitMs: 10 })).toBe(
			"in-use",
		);
		expect(root.calls).toEqual([]);
		releaseOwner();
	});

	it("bounds the wait with an abort signal sized to the device, never ifAvailable", async () => {
		const seen: Array<{ signal?: AbortSignal; ifAvailable?: boolean }> = [];
		const timeout = vi.spyOn(AbortSignal, "timeout");
		const locks = {
			request<T>(
				_name: string,
				options: {
					readonly signal?: AbortSignal;
					readonly ifAvailable?: boolean;
				},
				callback: (lock: unknown) => Promise<T>,
			): Promise<T> {
				seen.push(options);
				return callback({});
			},
		};
		await removeOpfsPool("signalled", { root: new FakeRoot(), locks });
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(seen[0]?.ifAvailable).toBeUndefined();
		expect(timeout).toHaveBeenCalledWith(
			ownerLockWaitMs(resolveMemoryProfile("auto").tier),
		);
		timeout.mockRestore();
	});

	it("rethrows a lock failure that is not a timeout", async () => {
		const locks = {
			request: async () => {
				throw domError("SecurityError");
			},
		};
		await expect(
			removeOpfsPool("locked-out", { root: new FakeRoot(), locks }),
		).rejects.toThrow(/SecurityError/);
	});

	it("reports timeout, not in-use, when the wait ends but no owner can be confirmed", async () => {
		const root = new FakeRoot();
		root.entries.add(".unconfirmed");
		const locks = {
			request: async () => {
				throw new DOMException("timed out", "TimeoutError");
			},
		};
		expect(
			await removeOpfsPool("unconfirmed", { root, locks, lockWaitMs: 10 }),
		).toBe("timeout");
		expect(root.calls).toEqual([]);
	});

	it("reports in-use only when the lock manager confirms a live owner after the wait", async () => {
		const locks = {
			request: async () => {
				throw new DOMException("timed out", "TimeoutError");
			},
			query: async () => ({ held: [{ name: "confirmed-owner" }] }),
		};
		expect(
			await removeOpfsPool("confirmed", {
				root: new FakeRoot(),
				locks,
				lockWaitMs: 10,
			}),
		).toBe("in-use");
		const released = {
			...locks,
			query: async () => ({ held: [{ name: "someone-else-owner" }] }),
		};
		expect(
			await removeOpfsPool("confirmed", {
				root: new FakeRoot(),
				locks: released,
				lockWaitMs: 10,
			}),
		).toBe("timeout");
	});

	it.each([
		["full", 4_000],
		["lite", 8_000],
		["minimal", 16_000],
	] as const)(
		"waits at least 4 s, longer on slower devices: %s -> %i ms",
		(tier, ms) => {
			expect(ownerLockWaitMs(tier)).toBe(ms);
		},
	);

	it("rethrows a null rejection unchanged", async () => {
		const root: OpfsRoot = {
			removeEntry: async () => {
				throw null;
			},
		};
		await expect(removeOpfsPool("pool", { root })).rejects.toBeNull();
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
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("asks for the owner lock exclusively, with a bounded wait (was: only if free)", async () => {
		const root = new FakeRoot();
		const inner = navigatorLikeLocks();
		const seen: Array<{ mode?: string; ifAvailable?: boolean }> = [];
		const locks = {
			request<T>(
				name: string,
				options: {
					readonly mode?: "exclusive";
					readonly ifAvailable?: boolean;
				},
				callback: (lock: unknown) => Promise<T>,
			): Promise<T> {
				seen.push(options);
				return inner.request(name, options, callback);
			},
		};
		expect(await removeSqlDatabase("modes", { root, locks })).toBe("absent");
		// Contract reversed: ifAvailable reported a closing owner as in-use.
		expect(seen).toEqual([
			{ mode: "exclusive", signal: expect.any(AbortSignal) },
		]);
	});

	it("uses navigator.locks by default, so an open database is in-use", async () => {
		const root = new FakeRoot();
		const pool = await sqlDatabasePoolName("held");
		root.entries.add(`.${pool}`);
		const locks = navigatorLikeLocks();
		vi.stubGlobal("navigator", { locks });
		const owner = await openSqlStorage(
			{
				openMemory: () => ({}),
				installPool: async () => ({ OpfsSAHPoolDb: class {} }),
				locks,
				warn: () => undefined,
				lockWaitMs: 10,
				tempStore: "memory",
			},
			{ name: "held" },
		);
		expect(await removeSqlDatabase("held", { root })).toBe("in-use");
		expect(root.entries.has(`.${pool}`)).toBe(true);
		owner.release();
	});

	it.each([
		[new Error("denied"), "OPFS root refused: denied"],
		["not an Error", "OPFS root refused: not an Error"],
	])(
		"turns a refused OPFS root (%s) into opfs-unavailable",
		async (failure, message) => {
			vi.stubGlobal("navigator", {
				storage: {
					getDirectory: async () => {
						throw failure;
					},
				},
			});
			const removing = removeSqlDatabase("refused");
			await expect(removing).rejects.toBeInstanceOf(SqlStorageUnavailableError);
			await expect(removing).rejects.toMatchObject({
				reason: "opfs-unavailable",
				message,
			});
		},
	);

	it("removes without a lock where there is no navigator at all", async () => {
		const root = new FakeRoot();
		const pool = await sqlDatabasePoolName("bare");
		root.entries.add(`.${pool}`);
		vi.stubGlobal("navigator", undefined);
		expect(await removeSqlDatabase("bare", { root })).toBe("removed");
	});

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
				tempStore: "memory",
			},
			{ name: "live" },
		);
		expect(await removeSqlDatabase("live", { root, locks })).toBe("in-use");
		expect(root.calls).toEqual([]);
		owner.release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(await removeSqlDatabase("live", { root, locks })).toBe("removed");
	});

	it("defaults to navigator.storage and navigator.locks", async () => {
		const root = new FakeRoot();
		const pool = await sqlDatabasePoolName("defaults");
		root.entries.add(`.${pool}`);
		const nav = globalThis.navigator as unknown as Record<string, unknown>;
		const before = { storage: nav.storage, locks: nav.locks };
		Object.defineProperty(nav, "storage", {
			configurable: true,
			value: { getDirectory: async () => root },
		});
		Object.defineProperty(nav, "locks", {
			configurable: true,
			value: navigatorLikeLocks(),
		});
		try {
			expect(await removeSqlDatabase("defaults")).toBe("removed");
			expect(await removeOpfsPool(pool)).toBe("absent");
		} finally {
			Object.defineProperty(nav, "storage", {
				configurable: true,
				value: before.storage,
			});
			Object.defineProperty(nav, "locks", {
				configurable: true,
				value: before.locks,
			});
		}
	});
});

/** Minimal exclusive Web Locks with ifAvailable support. */
function navigatorLikeLocks() {
	const held = new Set<string>();
	return {
		async query() {
			return { held: [...held].map((name) => ({ name })) };
		},
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
