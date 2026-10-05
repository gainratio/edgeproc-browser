// Test-only: inspect and damage an opfs-sahpool on the in-memory OPFS
// (memoryOpfs.ts), the way an older release could leave it.

interface Directory {
	getDirectoryHandle(name: string): Promise<Directory>;
	entries(): AsyncIterable<[string, { readonly kind: string }]>;
}

/** The pool's slot files on disk, as the next setup will find them. */
export async function slotCount(pool: string): Promise<number> {
	const root = (await navigator.storage.getDirectory()) as unknown as Directory;
	const opaque = await (
		await root.getDirectoryHandle(`.${pool}`)
	).getDirectoryHandle(".opaque");
	let count = 0;
	for await (const [, handle] of opaque.entries()) {
		if (handle.kind === "file") count += 1;
	}
	return count;
}

interface Shrinkable {
	getCapacity(): number;
	reduceCapacity(n: number): Promise<number>;
	pauseVfs(): unknown;
}

/** Leave the pool with one slot (no room for a journal), then let go of it. */
export async function shrinkToOneSlot(pool: unknown): Promise<void> {
	const shrinkable = pool as Shrinkable;
	await shrinkable.reduceCapacity(shrinkable.getCapacity() - 1);
	if (shrinkable.getCapacity() !== 1) {
		throw new Error(`pool kept ${shrinkable.getCapacity()} slots`);
	}
	shrinkable.pauseVfs();
}
