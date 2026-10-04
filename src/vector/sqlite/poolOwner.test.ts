import { describe, expect, it, vi } from "vitest";
import { FakeLocks } from "../../sql/__fixtures__/fakeLocks";
import { SqlStorageUnavailableError } from "../../sql/types";
import { disposeOwned, ownPool } from "./poolOwner";

/** A lock manager that lets go a task AFTER the callback settles, as browsers do. */
function slowReleaseLocks() {
	const state = { held: false };
	const locks = {
		request<T>(
			_name: string,
			_options: unknown,
			callback: (lock: unknown) => Promise<T>,
		): Promise<T> {
			state.held = true;
			return callback({}).then(async (value) => {
				await new Promise((resolve) => setTimeout(resolve, 0));
				state.held = false;
				return value;
			});
		},
	};
	return { locks, state };
}

const pool = () => ({ pauseVfs: vi.fn() });

describe("ownPool + disposeOwned (the vector Worker's pool lifecycle)", () => {
	it("holds the pool's owner lock while the index is open", async () => {
		const locks = new FakeLocks();
		const owned = await ownPool(locks, "p", 50, async () => pool());
		expect(locks.isHeld("p-owner")).toBe(true);
		await owned.release();
		expect(locks.isHeld("p-owner")).toBe(false);
	});

	it("dispose resolves only once the owner lock is actually free", async () => {
		const { locks, state } = slowReleaseLocks();
		const owned = await ownPool(locks, "p", 50, async () => pool());
		const index = { dispose: vi.fn(async () => undefined) };
		await disposeOwned(index, owned.release);
		expect(index.dispose).toHaveBeenCalledTimes(1);
		expect(state.held).toBe(false);
	});

	it("still frees the pool when closing the index throws", async () => {
		const { locks, state } = slowReleaseLocks();
		const vfs = pool();
		const owned = await ownPool(locks, "p", 50, async () => vfs);
		const index = {
			dispose: async () => {
				throw new Error("close failed");
			},
		};
		await expect(disposeOwned(index, owned.release)).rejects.toThrow(
			"close failed",
		);
		expect(vfs.pauseVfs).toHaveBeenCalledTimes(1);
		expect(state.held).toBe(false);
	});

	it("closes the pool's handles BEFORE letting go of the lock", async () => {
		const locks = new FakeLocks();
		const order: string[] = [];
		const owned = await ownPool(locks, "p", 50, async () => ({
			pauseVfs: () => order.push(`paused, held=${locks.isHeld("p-owner")}`),
		}));
		await owned.release();
		expect(order).toEqual(["paused, held=true"]);
	});

	it("refuses a second owner with a typed pool-in-use error after the wait", async () => {
		const locks = new FakeLocks();
		const first = await ownPool(locks, "p", 50, async () => pool());
		const install = vi.fn(async () => pool());
		const second = ownPool(locks, "p", 10, install);
		await expect(second).rejects.toBeInstanceOf(SqlStorageUnavailableError);
		await expect(second).rejects.toMatchObject({ reason: "pool-in-use" });
		expect(install).not.toHaveBeenCalled();
		await first.release();
	});

	it("lets go of the lock when installing the pool fails", async () => {
		const locks = new FakeLocks();
		await expect(
			ownPool(locks, "p", 50, async () => {
				throw new Error("install failed");
			}),
		).rejects.toThrow("install failed");
		expect(locks.isHeld("p-owner")).toBe(false);
	});
});
