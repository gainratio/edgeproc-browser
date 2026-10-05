// Test-only: an in-memory OPFS (directory and file handles with synchronous
// access handles), enough for SQLite's opfs-sahpool VFS to install and run in
// Node. It lets the pinned build's sahpool locking be proven in-process; the
// real-browser proofs stay in test/browser.

type Bytes = ArrayBufferView;

function view(buffer: Bytes): Uint8Array {
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

class FileData {
	public bytes = new Uint8Array(0);
	public size = 0;
	public locked = false;

	public grow(size: number): void {
		if (size <= this.bytes.length) return;
		const next = new Uint8Array(Math.max(size, this.bytes.length * 2));
		next.set(this.bytes);
		this.bytes = next;
	}
}

class MemorySyncAccessHandle {
	readonly #data: FileData;

	public constructor(data: FileData) {
		this.#data = data;
	}

	public read(buffer: Bytes, options: { readonly at?: number } = {}): number {
		const at = options.at ?? 0;
		const target = view(buffer);
		const n = Math.max(0, Math.min(target.length, this.#data.size - at));
		target.set(this.#data.bytes.subarray(at, at + n));
		return n;
	}

	public write(buffer: Bytes, options: { readonly at?: number } = {}): number {
		const at = options.at ?? 0;
		const source = view(buffer);
		this.#data.grow(at + source.length);
		this.#data.bytes.set(source, at);
		this.#data.size = Math.max(this.#data.size, at + source.length);
		return source.length;
	}

	public getSize(): number {
		return this.#data.size;
	}

	public truncate(size: number): void {
		this.#data.grow(size);
		if (size < this.#data.size) this.#data.bytes.fill(0, size, this.#data.size);
		this.#data.size = size;
	}

	public flush(): void {}

	public close(): void {
		this.#data.locked = false;
	}
}

export class MemoryFileSystemHandle {
	public readonly name: string;
	public readonly kind: "file" | "directory";

	public constructor(name: string, kind: "file" | "directory") {
		this.name = name;
		this.kind = kind;
	}
}

export class MemoryFileHandle extends MemoryFileSystemHandle {
	readonly #data = new FileData();

	public constructor(name: string) {
		super(name, "file");
	}

	/** Whether a sync access handle currently holds this file open. */
	public get locked(): boolean {
		return this.#data.locked;
	}

	public async createSyncAccessHandle(): Promise<MemorySyncAccessHandle> {
		if (this.#data.locked) {
			throw new DOMException(this.name, "NoModificationAllowedError");
		}
		this.#data.locked = true;
		return new MemorySyncAccessHandle(this.#data);
	}
}

export class MemoryDirectoryHandle extends MemoryFileSystemHandle {
	readonly #entries = new Map<
		string,
		MemoryFileHandle | MemoryDirectoryHandle
	>();

	public constructor(name: string) {
		super(name, "directory");
	}

	public async getDirectoryHandle(
		name: string,
		options: { readonly create?: boolean } = {},
	): Promise<MemoryDirectoryHandle> {
		const found = this.#entries.get(name);
		if (found instanceof MemoryDirectoryHandle) return found;
		if (found !== undefined || options.create !== true) {
			throw new DOMException(name, "NotFoundError");
		}
		const created = new MemoryDirectoryHandle(name);
		this.#entries.set(name, created);
		return created;
	}

	public async getFileHandle(
		name: string,
		options: { readonly create?: boolean } = {},
	): Promise<MemoryFileHandle> {
		const found = this.#entries.get(name);
		if (found instanceof MemoryFileHandle) return found;
		if (found !== undefined || options.create !== true) {
			throw new DOMException(name, "NotFoundError");
		}
		const created = new MemoryFileHandle(name);
		this.#entries.set(name, created);
		return created;
	}

	/**
	 * A file a handle holds open cannot be removed. A recursive removal here
	 * deletes what it can before failing on such a file: the worst case, a
	 * removal racing a handle that opens mid-delete. (Chromium and Firefox
	 * refuse the whole removal up front when a handle is already open.) It is
	 * how a failed opfs-sahpool setup, which used to remove its pool, could
	 * strip the free slots and leave the held ones.
	 */
	public async removeEntry(
		name: string,
		options: { readonly recursive?: boolean } = {},
	): Promise<void> {
		const found = this.#entries.get(name);
		if (found === undefined) throw new DOMException(name, "NotFoundError");
		if (found instanceof MemoryFileHandle) {
			if (found.locked) {
				throw new DOMException(name, "NoModificationAllowedError");
			}
		} else {
			await found.removeChildren(options.recursive === true);
		}
		this.#entries.delete(name);
	}

	private async removeChildren(recursive: boolean): Promise<void> {
		if (this.#entries.size === 0) return;
		if (!recursive) {
			throw new DOMException(this.name, "InvalidModificationError");
		}
		let failure: unknown;
		for (const name of [...this.#entries.keys()]) {
			await this.removeEntry(name, { recursive }).catch((error: unknown) => {
				failure ??= error;
			});
		}
		if (failure !== undefined) throw failure;
	}

	public async *entries(): AsyncIterableIterator<
		[string, MemoryFileHandle | MemoryDirectoryHandle]
	> {
		yield* [...this.#entries.entries()];
	}

	public [Symbol.asyncIterator](): AsyncIterableIterator<
		[string, MemoryFileHandle | MemoryDirectoryHandle]
	> {
		return this.entries();
	}
}

const GLOBALS = [
	"FileSystemHandle",
	"FileSystemDirectoryHandle",
	"FileSystemFileHandle",
] as const;

/** Install a fresh in-memory OPFS as the global one; returns an uninstaller. */
export function installMemoryOpfs(): () => void {
	const host = globalThis as Record<string, unknown>;
	const saved = GLOBALS.map((key) => [key, host[key]] as const);
	host.FileSystemHandle = MemoryFileSystemHandle;
	host.FileSystemDirectoryHandle = MemoryDirectoryHandle;
	host.FileSystemFileHandle = MemoryFileHandle;
	const root = new MemoryDirectoryHandle("");
	const storage = Object.getOwnPropertyDescriptor(navigator, "storage");
	Object.defineProperty(navigator, "storage", {
		configurable: true,
		value: { getDirectory: async () => root },
	});
	return () => {
		for (const [key, value] of saved) host[key] = value;
		if (storage === undefined) {
			Reflect.deleteProperty(navigator, "storage");
		} else {
			Object.defineProperty(navigator, "storage", storage);
		}
	};
}
