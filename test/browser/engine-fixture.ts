// Real-Chromium proof of the engine Worker's trust-root wiring: the legacy
// raw 32-byte key, a JSON keyring, and a keyring that revokes the signer, all
// against the committed signed bundle and the BUILT Worker (dist/), so the
// artifact consumers install is what runs.

import {
	deriveKeyId,
	EngineClient,
	EngineOperationError,
	KEYRING_SCHEMA,
} from "@gainratio/browser";

export interface EngineKeyringProof {
	readonly legacyVersion: string;
	readonly legacyMetaBytes: number;
	readonly keyringVersion: string;
	readonly keyringChunksReused: number;
	readonly revokedCode: string;
	readonly revokedPromotedNothing: boolean;
}

declare global {
	interface Window {
		runEngineKeyringProof(namespace: string): Promise<EngineKeyringProof>;
	}
}

// Served from disk by the spec's route handler: Vite would transform the
// extensionless pointer/manifest/chunk files as JavaScript modules.
const CATALOG = "/bundle-origin";
// The committed bundle's public key (src/engine/__fixtures__/bundle/keys/
// public.key). Vite refuses to serve *.key files, so the page hands the Worker
// the same 32 raw bytes through a blob: URL — still the legacy wire form.
const BUNDLE_PUBLIC_KEY =
	"a54f579302474524d95bc5363818f81852a928dfc5974f7c87a331fd4faa12ce";
// Key A of the cross-runtime vectors (seed = 32 x 0x01): a second, unrelated
// key so the keyring is a real multi-key ring.
const OTHER = {
	key_id: "34750f98bd59fcfc",
	public_key:
		"8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c",
};

function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

function fromHex(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(
		(text.match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16)),
	);
}

function engine(): EngineClient {
	return new EngineClient(
		new Worker(new URL("/dist/engine/worker.js", location.href), {
			type: "module",
		}),
		{ idleTimeoutMs: 60_000 },
	);
}

function keyringUrl(document: unknown): string {
	return URL.createObjectURL(
		new Blob([JSON.stringify(document)], { type: "application/json" }),
	);
}

window.runEngineKeyringProof = async (namespace) => {
	const raw = fromHex(BUNDLE_PUBLIC_KEY);
	const bundleKey = { key_id: await deriveKeyId(raw), public_key: hex(raw) };
	const rawKeyUrl = URL.createObjectURL(new Blob([raw]));

	const legacy = engine();
	const legacyResult = await legacy.sync(CATALOG, rawKeyUrl, {
		cacheNamespace: `${namespace}-legacy`,
		wantedPaths: ["catalog_meta.json"],
	});
	const meta = await legacy.readFile("catalog_meta.json");
	legacy.dispose();

	const ringed = engine();
	const ringResult = await ringed.sync(
		CATALOG,
		keyringUrl({
			schema: KEYRING_SCHEMA,
			keys: [OTHER, bundleKey],
			revoked: [],
		}),
		{ cacheNamespace: `${namespace}-ring`, wantedPaths: ["catalog_meta.json"] },
	);
	// Offline-style re-sync over the primed cache under the same ring.
	const again = await ringed.sync(
		CATALOG,
		keyringUrl({
			schema: KEYRING_SCHEMA,
			keys: [OTHER, bundleKey],
			revoked: [],
		}),
		{ cacheNamespace: `${namespace}-ring`, wantedPaths: ["catalog_meta.json"] },
	);
	ringed.dispose();

	const revoked = engine();
	let revokedCode = "accepted";
	try {
		await revoked.sync(
			CATALOG,
			keyringUrl({
				schema: KEYRING_SCHEMA,
				keys: [OTHER, bundleKey],
				revoked: [bundleKey.key_id],
			}),
			// Its own namespace = its own SQLite database, empty of the releases above.
			{
				cacheNamespace: `${namespace}-revoked`,
				wantedPaths: [],
			},
		);
	} catch (error) {
		revokedCode =
			error instanceof EngineOperationError ? error.code : String(error);
	}
	let revokedPromotedNothing = false;
	try {
		await revoked.readFile("catalog_meta.json");
	} catch {
		revokedPromotedNothing = true;
	}
	revoked.dispose();

	return {
		legacyVersion: legacyResult.version,
		legacyMetaBytes: meta.byteLength,
		keyringVersion: ringResult.version,
		keyringChunksReused: again.chunksReused,
		revokedCode,
		revokedPromotedNothing,
	};
};
