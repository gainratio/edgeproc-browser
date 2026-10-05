/// <reference lib="webworker" />

// Test-only Worker that plays a dying Worker's access handles: it opens every
// slot file of an opfs-sahpool, reports "held", then closes them one at a
// time. Chromium closes a terminated Worker's handles before it frees that
// Worker's Web Locks, so on a fast machine the reload race (a new owner
// setting the pool up while old handles are still closing) is rare; this
// makes it happen every round, on the browser's real OPFS.

export interface GhostRequest {
	readonly pool: string;
	readonly stepMs: number;
}

self.onmessage = async ({ data }: MessageEvent<GhostRequest>) => {
	try {
		const root = await navigator.storage.getDirectory();
		const opaque = await (
			await root.getDirectoryHandle(`.${data.pool}`)
		).getDirectoryHandle(".opaque");
		const handles: FileSystemSyncAccessHandle[] = [];
		for await (const [, entry] of (
			opaque as unknown as {
				entries(): AsyncIterable<[string, FileSystemHandle]>;
			}
		).entries()) {
			if (entry.kind === "file") {
				handles.push(
					await (entry as FileSystemFileHandle).createSyncAccessHandle(),
				);
			}
		}
		self.postMessage({ held: handles.length });
		for (const handle of handles) {
			await new Promise((resolve) => setTimeout(resolve, data.stepMs));
			handle.close();
		}
		self.postMessage({ released: handles.length });
	} catch (error) {
		self.postMessage({ error: String(error) });
	}
};
