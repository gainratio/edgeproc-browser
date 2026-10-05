import { describe, expect, it, vi } from "vitest";
import { FakeLocks } from "./__fixtures__/fakeLocks";
import { openSqlStorage, sqlDatabasePoolName } from "./open";
import { SqlStorageUnavailableError } from "./types";

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

	it("release() resolves only once the owner lock is actually free", async () => {
		// A real lock manager lets go a task AFTER the callback settles; the
		// request's own promise is the only signal that it has.
		let held = false;
		const locks = {
			request<T>(
				_name: string,
				_options: unknown,
				callback: (lock: unknown) => Promise<T>,
			): Promise<T> {
				held = true;
				return callback({}).then(async (value) => {
					await new Promise((resolve) => setTimeout(resolve, 0));
					held = false;
					return value;
				});
			},
		};
		const opened = await openSqlStorage(deps({ locks }), { name: "settled" });
		expect(held).toBe(true);
		await opened.release();
		expect(held).toBe(false);
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
		expect(second.storage).toEqual({
			persistence: "memory",
			reason: "pool-in-use",
			detail: "another context owns it",
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

	it("classifies contention by DOMException name or by the sahpool message", async () => {
		for (const failure of [
			named("NoModificationAllowedError", "handle busy"),
			new Error("Access handle cannot be created"),
			new Error("access handles cannot be created for pool"),
		]) {
			const opened = await openSqlStorage(
				deps({
					locks: undefined,
					installPool: vi.fn(async () => {
						throw failure;
					}),
				}),
				{ name: "contended", fallback: "memory" },
			);
			expect(opened.storage).toMatchObject({ reason: "pool-in-use" });
		}
	});

	it("requests the owner lock exclusively, bounded by lockWaitMs", async () => {
		const inner = new FakeLocks();
		const seen: Array<{ mode?: string; signal?: AbortSignal }> = [];
		const d = deps({
			lockWaitMs: 5_000,
			locks: {
				request: (name, options, callback) => {
					seen.push(options);
					return inner.request(name, options, callback);
				},
			},
		});
		const opened = await openSqlStorage(d, { name: "exclusive" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.mode).toBe("exclusive");
		expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(seen[0]?.signal?.aborted).toBe(false);
		opened.release();
	});

	it("waits out a by-name operation (an import) that holds the pool past the wait budget", async () => {
		// CI run 37230731318: a writer opened while importDatabase(name) held
		// the owner lock for longer than lockWaitMs, and failed pool-in-use.
		const d = deps({ lockWaitMs: 20 });
		const importing = await openSqlStorage(
			d,
			{ name: "busy-import" },
			{ transient: true },
		);
		const pool = await sqlDatabasePoolName("busy-import");
		expect((d.locks as FakeLocks).isHeld(`${pool}-operation`)).toBe(true);
		const writer = openSqlStorage(d, { name: "busy-import" });
		await new Promise((resolve) => setTimeout(resolve, 80));
		await importing.release();
		expect((d.locks as FakeLocks).isHeld(`${pool}-operation`)).toBe(false);
		const opened = await writer;
		expect(opened.storage).toMatchObject({ persistence: "opfs" });
		await opened.release();
	});

	it("still fails closed after the wait when a connection (not an operation) owns the pool", async () => {
		const d = deps({ lockWaitMs: 20 });
		const owner = await openSqlStorage(d, { name: "long-lived" });
		await expect(
			openSqlStorage(d, { name: "long-lived" }),
		).rejects.toMatchObject({ reason: "pool-in-use" });
		await owner.release();
	});

	it("takes the lock again when its owner let go between the timeout and the check", async () => {
		const inner = new FakeLocks();
		let calls = 0;
		const d = deps({
			locks: {
				request: (name, options, callback) => {
					calls += 1;
					if (calls === 1) {
						return Promise.reject(new DOMException("t", "TimeoutError"));
					}
					return inner.request(name, options, callback);
				},
				query: async () => ({ held: [] }),
			},
		});
		const opened = await openSqlStorage(d, { name: "freed" });
		expect(opened.storage).toMatchObject({ persistence: "opfs" });
		expect(calls).toBe(2);
		await opened.release();
	});

	it("treats the browser's TimeoutError from AbortSignal.timeout as pool-in-use", async () => {
		const d = deps({
			locks: {
				request: async () => {
					throw new DOMException("timed out", "TimeoutError");
				},
			},
		});
		const opened = await openSqlStorage(d, {
			name: "timeout",
			fallback: "memory",
		});
		expect(opened.storage).toMatchObject({ reason: "pool-in-use" });
		expect(d.installPool).not.toHaveBeenCalled();
	});

	it("propagates a null Web Locks rejection unchanged", async () => {
		const d = deps({
			locks: {
				request: async () => {
					throw null;
				},
			},
		});
		await expect(openSqlStorage(d, { name: "null" })).rejects.toBeNull();
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

	it("propagates a Web Locks failure that is not a timeout", async () => {
		const d = deps({
			locks: {
				request: async () => {
					throw new TypeError("locks broken");
				},
			},
		});
		await expect(openSqlStorage(d, { name: "broken" })).rejects.toThrow(
			/locks broken/,
		);
	});

	it("has nothing to release for a memory database", async () => {
		const d = deps({ locks: undefined });
		const requested = await openSqlStorage(d, {
			name: "m",
			persistence: "memory",
		});
		expect(() => requested.release()).not.toThrow();
		const fallback = await openSqlStorage(
			deps({
				installPool: vi.fn(async () => {
					throw "not an Error";
				}),
			}),
			{ name: "f", fallback: "memory" },
		);
		expect(fallback.storage).toMatchObject({
			reason: "opfs-unavailable",
			detail: "not an Error",
		});
		expect(() => fallback.release()).not.toThrow();
	});
});
