import { describe, expect, it, vi } from "vitest";
import { openSqlStorage, type SqlLocks, sqlDatabasePoolName } from "./open";
import { SqlStorageUnavailableError } from "./types";

/** A tiny exclusive Web Locks model: queued waiters, abortable by signal. */
class FakeLocks implements SqlLocks {
	readonly #held = new Set<string>();
	readonly #waiters = new Map<string, Array<() => void>>();

	public isHeld(name: string): boolean {
		return this.#held.has(name);
	}

	public request<T>(
		name: string,
		options: { readonly signal?: AbortSignal },
		callback: (lock: unknown) => Promise<T>,
	): Promise<T> {
		const run = async (): Promise<T> => {
			this.#held.add(name);
			try {
				return await callback({ name });
			} finally {
				this.#held.delete(name);
				this.#waiters.get(name)?.shift()?.();
			}
		};
		if (!this.#held.has(name)) return run();
		return new Promise<T>((resolve, reject) => {
			const queue = this.#waiters.get(name) ?? [];
			this.#waiters.set(name, queue);
			const go = () => run().then(resolve, reject);
			queue.push(go);
			options.signal?.addEventListener("abort", () => {
				queue.splice(queue.indexOf(go), 1);
				reject(new DOMException("aborted", "AbortError"));
			});
		});
	}
}

class Raw {
	public readonly file: string;
	public constructor(file: string) {
		this.file = file;
	}
}

function deps(
	overrides: Partial<Parameters<typeof openSqlStorage<Raw>>[0]> = {},
) {
	return {
		openMemory: () => new Raw(":memory:"),
		installPool: vi.fn(async (_name: string) => ({
			OpfsSAHPoolDb: Raw,
		})),
		locks: new FakeLocks(),
		warn: vi.fn(),
		lockWaitMs: 20,
		...overrides,
	};
}

function named(error: string, message = error): Error {
	const failure = new Error(message);
	failure.name = error;
	return failure;
}

describe("openSqlStorage", () => {
	it("opens the named database in its own OPFS sahpool and holds the owner lock", async () => {
		const d = deps();
		const pool = await sqlDatabasePoolName("catalogue");
		expect(pool).toMatch(/^edgeproc-sql-[0-9a-f]{32}$/);
		const opened = await openSqlStorage(d, { name: "catalogue" });
		expect(opened.storage).toEqual({
			persistence: "opfs",
			pool,
			file: `/${pool}.sqlite3`,
		});
		expect(opened.raw.file).toBe(`/${pool}.sqlite3`);
		expect(d.installPool).toHaveBeenCalledWith(pool);
		expect((d.locks as FakeLocks).isHeld(`${pool}-owner`)).toBe(true);
		opened.release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect((d.locks as FakeLocks).isHeld(`${pool}-owner`)).toBe(false);
	});

	it("pauses the pool (frees its OPFS handles) before releasing the owner lock", async () => {
		const order: string[] = [];
		const locks = new FakeLocks();
		const d = deps({
			locks,
			installPool: vi.fn(async () => ({
				OpfsSAHPoolDb: Raw,
				pauseVfs: () => {
					order.push(`paused:${String(locks.isHeld(pool))}`);
				},
			})),
		});
		const pool = `${await sqlDatabasePoolName("handles")}-owner`;
		const opened = await openSqlStorage(d, { name: "handles" });
		opened.release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(order).toEqual(["paused:true"]);
		expect(locks.isHeld(pool)).toBe(false);
	});

	it("reports pool-in-use and opens in memory when another tab owns the pool", async () => {
		const d = deps();
		const owner = await openSqlStorage(d, { name: "shared" });
		const second = await openSqlStorage(d, {
			name: "shared",
			fallback: "memory",
		});
		expect(second.storage).toMatchObject({
			persistence: "memory",
			reason: "pool-in-use",
		});
		expect(second.raw.file).toBe(":memory:");
		expect(d.installPool).toHaveBeenCalledTimes(1);
		expect(d.warn).toHaveBeenCalledWith(expect.stringMatching(/pool-in-use/));
		owner.release();
	});

	it("fails closed with a typed error when no fallback is allowed", async () => {
		const d = deps();
		const owner = await openSqlStorage(d, { name: "shared" });
		const refused = openSqlStorage(d, { name: "shared" });
		await expect(refused).rejects.toBeInstanceOf(SqlStorageUnavailableError);
		await expect(refused).rejects.toMatchObject({ reason: "pool-in-use" });
		owner.release();
	});

	it("waits briefly for a previous owner (a reload) instead of falling back", async () => {
		const d = deps({ lockWaitMs: 1_000 });
		const owner = await openSqlStorage(d, { name: "reload" });
		const next = openSqlStorage(d, { name: "reload" });
		setTimeout(() => owner.release(), 10);
		expect((await next).storage.persistence).toBe("opfs");
	});

	it("reports opfs-unavailable when OPFS itself fails, and releases the lock", async () => {
		const d = deps({
			installPool: vi.fn(async () => {
				throw named("UnknownError", "getDirectory failed");
			}),
		});
		const opened = await openSqlStorage(d, {
			name: "private",
			fallback: "memory",
		});
		expect(opened.storage).toEqual({
			persistence: "memory",
			reason: "opfs-unavailable",
			detail: "getDirectory failed",
		});
		const pool = await sqlDatabasePoolName("private");
		expect((d.locks as FakeLocks).isHeld(`${pool}-owner`)).toBe(false);
		await expect(openSqlStorage(d, { name: "private" })).rejects.toMatchObject({
			reason: "opfs-unavailable",
		});
	});

	it("classifies sync-access-handle contention as pool-in-use", async () => {
		const d = deps({
			locks: undefined,
			installPool: vi.fn(async () => {
				throw named("NoModificationAllowedError");
			}),
		});
		const opened = await openSqlStorage(d, {
			name: "contended",
			fallback: "memory",
		});
		expect(opened.storage).toMatchObject({ reason: "pool-in-use" });
	});

	it("opens without a lease where Web Locks are missing", async () => {
		const d = deps({ locks: undefined });
		const opened = await openSqlStorage(d, { name: "nolocks" });
		expect(opened.storage.persistence).toBe("opfs");
		opened.release();
	});

	it("opens in memory without touching OPFS when memory is requested", async () => {
		const d = deps();
		const opened = await openSqlStorage(d, {
			name: "scratch",
			persistence: "memory",
		});
		expect(opened.storage).toEqual({
			persistence: "memory",
			reason: "requested",
		});
		expect(d.installPool).not.toHaveBeenCalled();
		expect(d.warn).not.toHaveBeenCalled();
	});

	it("rejects an unknown persistence", async () => {
		await expect(
			openSqlStorage(deps(), {
				name: "x",
				persistence: "disk" as unknown as "opfs",
			}),
		).rejects.toThrow(/unsupported SQL persistence/);
	});
});
