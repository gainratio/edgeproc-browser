// Offline trust root + verified cache reads: a sync persists the public trust
// root, an offline sync can start from it, and readFile refuses a pointer that
// is not signed by the current root (including a revoked key).

import { getPublicKeyAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { SignatureError } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { catalogFetch, pubkeyRaw } from "./fixtures.js";
import { IntegrityError } from "./integrity.js";
import {
	deriveKeyId,
	KEYRING_SCHEMA,
	KeyRevokedError,
	loadTrustRootForSync,
	parseTrustRoot,
} from "./keyring.js";
import { MemoryCacheStore } from "./memoryStore.js";
import { readVerifiedFile, syncIndex } from "./sync.js";
import type { FetchBytes } from "./types.js";

const ENCODER = new TextEncoder();
const KEY_URL = "https://example.test/public.key";
const offline: FetchBytes = () => Promise.reject(new NetworkError("offline"));

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

async function syncedStore(): Promise<MemoryCacheStore> {
	const store = new MemoryCacheStore();
	const catalog = catalogFetch();
	await syncIndex({
		baseUrl: "/cat",
		store,
		fetchBytes: catalog.fetchBytes,
		keyring: await parseTrustRoot(pubkeyRaw()),
	});
	return store;
}

describe("the sync trust root survives the network going away", () => {
	it("persists the verified root and uses it when the next fetch fails", async () => {
		const store = new MemoryCacheStore();
		const online: FetchBytes = () => Promise.resolve(pubkeyRaw());

		const first = await loadTrustRootForSync(KEY_URL, online, store);
		expect(await store.readTrustRoot()).toEqual(pubkeyRaw());

		const second = await loadTrustRootForSync(KEY_URL, offline, store);
		expect(second.keys.map((key) => key.keyId)).toEqual(
			first.keys.map((key) => key.keyId),
		);
	});

	it("fails with the network error when nothing is cached", async () => {
		const store = new MemoryCacheStore();
		await expect(
			loadTrustRootForSync(KEY_URL, offline, store),
		).rejects.toBeInstanceOf(NetworkError);
	});

	it("fails closed when the cached root is malformed", async () => {
		const store = new MemoryCacheStore();
		await store.putTrustRoot(new Uint8Array([1, 2, 3]));
		await expect(
			loadTrustRootForSync(KEY_URL, offline, store),
		).rejects.toBeInstanceOf(IntegrityError);
	});
});

describe("a cached file read is authenticated, not just materialized", () => {
	it("serves a file from the cache under the persisted trust root", async () => {
		const store = await syncedStore();
		// syncedStore does not persist the root (syncIndex takes a Keyring), so a
		// read before the worker's cache step must fail closed.
		await expect(
			readVerifiedFile(store, "catalog_meta.json"),
		).rejects.toBeInstanceOf(IntegrityError);

		await store.putTrustRoot(pubkeyRaw());
		const bytes = await readVerifiedFile(store, "catalog_meta.json");
		expect(bytes.byteLength).toBeGreaterThan(0);
		expect(JSON.parse(new TextDecoder().decode(bytes))).toBeTypeOf("object");
	});

	it("refuses a cached pointer whose signature no longer verifies", async () => {
		const store = await syncedStore();
		await store.putTrustRoot(pubkeyRaw());
		const active = await store.readActive();
		if (active === null)
			throw new Error("fixture sync produced no active pointer");
		await store.promote({ ...active, signature: "AAAA" });

		await expect(
			readVerifiedFile(store, "catalog_meta.json"),
		).rejects.toBeInstanceOf(SignatureError);
	});

	it("refuses a pointer signed by a revoked key", async () => {
		const store = await syncedStore();
		const keyId = await deriveKeyId(pubkeyRaw());
		const otherPublic = await getPublicKeyAsync(new Uint8Array(32).fill(7));
		const revoked = {
			schema: KEYRING_SCHEMA,
			keys: [
				{ key_id: keyId, public_key: hex(pubkeyRaw()) },
				{
					key_id: await deriveKeyId(otherPublic),
					public_key: hex(otherPublic),
				},
			],
			revoked: [keyId],
		};
		await store.putTrustRoot(ENCODER.encode(JSON.stringify(revoked)));

		await expect(
			readVerifiedFile(store, "catalog_meta.json"),
		).rejects.toBeInstanceOf(KeyRevokedError);
	});
});
