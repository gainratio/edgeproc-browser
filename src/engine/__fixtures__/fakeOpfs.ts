// A tiny in-memory OPFS for Vitest (createSyncAccessHandle is Worker-only, so
// there is no real OPFS under node). It models the parts the stores rely on:
// exclusive sync access handles, lock-free getFile snapshots, directories and
// removeEntry. `stats` counts every sync access handle and file ever opened,
// which is how the throughput tests bound per-chunk storage round trips.

import { vi } from "vitest";

export interface FakeOpfsStats {
	syncHandles: number;
	filesCreated: number;
	/** When set, the next file created gets this handle failure. */
	nextCreateFailure: Error | undefined;
}

/** One OPFS file as a growable byte buffer; the sync access handle reads/writes it. */
export class FakeFile {
	public bytes = new Uint8Array();
	public handleFailure: Error | undefined;
	/** Real OPFS semantics: a sync access handle is EXCLUSIVE per file. */
	public handleOpen = false;
	public syncHandlesOpened = 0;
	readonly #stats: FakeOpfsStats | undefined;

	public constructor(stats?: FakeOpfsStats) {
		this.#stats = stats;
	}

	public createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle> {
		if (this.handleFailure !== undefined) {
			return Promise.reject(this.handleFailure);
		}
		if (this.handleOpen) {
			return Promise.reject(
				new DOMException("handle held", "NoModificationAllowedError"),
			);
		}
		this.handleOpen = true;
		this.syncHandlesOpened += 1;
		if (this.#stats !== undefined) this.#stats.syncHandles += 1;
		return Promise.resolve(
			new FakeSyncHandle(this) as unknown as FileSystemSyncAccessHandle,
		);
	}
	/** A read-only snapshot; takes no lock (as in Chromium, even while a sync
	 * access handle is held). */
	public getFile(): Promise<Blob> {
		return Promise.resolve(new Blob([this.bytes.slice()]));
	}
}

/** The Worker-only sync access handle surface the stores actually call. */
class FakeSyncHandle {
	readonly #file: FakeFile;
	public constructor(file: FakeFile) {
		this.#file = file;
	}
	public getSize(): number {
		return this.#file.bytes.length;
	}
	public read(buffer: Uint8Array, opts: { at: number }): number {
		const slice = this.#file.bytes.subarray(opts.at, opts.at + buffer.length);
		buffer.set(slice);
		return slice.length;
	}
	public write(data: Uint8Array, opts: { at: number }): number {
		const end = opts.at + data.length;
		if (end > this.#file.bytes.length) {
			const grown = new Uint8Array(end);
			grown.set(this.#file.bytes);
			this.#file.bytes = grown;
		}
		this.#file.bytes.set(data, opts.at);
		return data.length;
	}
	public truncate(size: number): void {
		this.#file.bytes = this.#file.bytes.slice(0, size);
	}
	public flush(): void {}
	public close(): void {
		this.#file.handleOpen = false;
	}
}

/** A minimal in-memory OPFS directory: files by name, child dirs, removeEntry. */
export class FakeDir {
	public readonly files = new Map<string, FakeFile>();
	public readonly dirs = new Map<string, FakeDir>();
	public readonly stats: FakeOpfsStats;

	public constructor(stats?: FakeOpfsStats) {
		this.stats = stats ?? {
			syncHandles: 0,
			filesCreated: 0,
			nextCreateFailure: undefined,
		};
	}

	public getDirectoryHandle(
		name: string,
		opts?: { create?: boolean },
	): Promise<FakeDir> {
		let dir = this.dirs.get(name);
		if (dir === undefined) {
			if (opts?.create !== true) {
				return Promise.reject(new DOMException(name, "NotFoundError"));
			}
			dir = new FakeDir(this.stats);
			this.dirs.set(name, dir);
		}
		return Promise.resolve(dir);
	}
	public getFileHandle(
		name: string,
		opts?: { create?: boolean },
	): Promise<FakeFile> {
		let file = this.files.get(name);
		if (file === undefined) {
			if (opts?.create !== true) {
				return Promise.reject(new DOMException(name, "NotFoundError"));
			}
			file = new FakeFile(this.stats);
			file.handleFailure = this.stats.nextCreateFailure;
			this.stats.nextCreateFailure = undefined;
			this.stats.filesCreated += 1;
			this.files.set(name, file);
		}
		return Promise.resolve(file);
	}
	public removeEntry(name: string): Promise<void> {
		if (!this.files.delete(name)) {
			return Promise.reject(new DOMException(name, "NotFoundError"));
		}
		return Promise.resolve();
	}
	public async *entries(): AsyncGenerator<[string, FakeFile]> {
		for (const entry of [...this.files]) yield entry;
	}
}

/** Point navigator.storage.getDirectory at a fresh fake OPFS root; return the root. */
export function stubOpfs(): FakeDir {
	const root = new FakeDir();
	vi.stubGlobal("navigator", {
		storage: { getDirectory: (): Promise<FakeDir> => Promise.resolve(root) },
	} as unknown as Navigator);
	return root;
}
