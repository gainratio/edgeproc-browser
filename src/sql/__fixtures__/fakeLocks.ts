// Test-only.
import type { SqlLocks } from "../open.js";

/** A tiny exclusive Web Locks model: queued waiters, abortable by signal. */
export class FakeLocks implements SqlLocks {
	readonly #held = new Set<string>();
	readonly #waiters = new Map<string, Array<() => void>>();

	public isHeld(name: string): boolean {
		return this.#held.has(name);
	}

	public async query(): Promise<{ held: Array<{ name: string }> }> {
		return { held: [...this.#held].map((name) => ({ name })) };
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
