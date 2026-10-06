#!/usr/bin/env node
// Generate the golden legacy-format fixtures for src/seal/legacy.test.ts by
// running the CURRENT almamesh and aml-filter encrypt code, then prove each file
// opens with those apps' own CURRENT readers before writing anything.
//
//   ALMAMESH_DIR=../almamesh AMLFILTER_DIR=../aml-filter \
//     node scripts/generate-legacy-seal-fixtures.mjs
//
// The app sources are loaded through Vite's SSR loader (TypeScript, extensionless
// imports). Two imports are stubbed because they are not crypto and pull in app
// state: almamesh's `./backup` (only `BackupError` is used) and aml-filter's
// `@gainratio/avow` (`publicKeyHex`, which is ed25519 public-key derivation; the
// stub is the same two calls avow 0.5.2 makes, on @noble/ed25519).
//
// Randomness (salt, IV) comes from a fixed counter so a rerun reproduces the
// same bytes. That is safe ONLY because these are public test fixtures.
//
// almamesh has no v2 writer any more (only the reader), so the v2 file is
// written here with the reader's exact AAD layout, then opened by the current
// almamesh reader like the others.

import { createHash, webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "seal", "__fixtures__", "legacy");
const ALMAMESH = resolve(
	process.env.ALMAMESH_DIR ?? join(ROOT, "..", "almamesh"),
);
const AMLFILTER = resolve(
	process.env.AMLFILTER_DIR ?? join(ROOT, "..", "aml-filter"),
);
const STORE = join(ALMAMESH, "frontend/packages/store/src");
const INSTALL_KEY = join(
	AMLFILTER,
	"frontend/packages/amlfilter-browser/src/engine/installKeyExport.ts",
);
const NOW = "2026-10-06T00:00:00.000Z";

let counter = 0;
globalThis.crypto.getRandomValues = (array) => {
	for (let i = 0; i < array.length; i += 1) {
		counter += 1;
		array[i] = (counter * 131 + 7) % 256;
	}
	return array;
};

const STUBS = {
	backup: "\0stub:backup",
	avow: "\0stub:avow",
};
const stubPlugin = {
	name: "legacy-fixture-stubs",
	enforce: "pre",
	resolveId(source, importer) {
		if (source === "./backup" && importer?.startsWith(STORE))
			return STUBS.backup;
		if (source === "@gainratio/avow") return STUBS.avow;
		return null;
	},
	load(id) {
		if (id === STUBS.backup) {
			return `export class BackupError extends Error {
				constructor(code, message) { super(message); this.code = code; this.name = "BackupError"; }
			}`;
		}
		if (id === STUBS.avow) {
			return `import { etc, getPublicKeyAsync } from ${JSON.stringify(
				join(ROOT, "node_modules/@noble/ed25519/index.js"),
			)};
			export async function publicKeyHex(seedHex) {
				return etc.bytesToHex(await getPublicKeyAsync(etc.hexToBytes(seedHex)));
			}`;
		}
		return null;
	},
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const equal = (a, b) => Buffer.from(a).equals(Buffer.from(b));
function check(condition, message) {
	if (!condition) throw new Error(`fixture check failed: ${message}`);
}

function fakeDatabase() {
	const bytes = new Uint8Array(4096).map((_, i) => (i * 37 + 11) % 256);
	bytes.set(new TextEncoder().encode("SQLite format 3\0"));
	return bytes;
}

async function v3(portable, database) {
	const passphrase = "portable v3 passphrase";
	const file = await portable.sealPortableBundle(database, passphrase, {
		now: NOW,
	});
	const opened = await portable.openPortableBundle(file, passphrase);
	check(equal(opened.database, database), "v3 reopen");
	return {
		name: "almamesh-portable-v3.bin",
		bytes: file,
		format: "almamesh-portable-v3",
		passphrase,
		iterations: 600_000,
		plaintext: database,
	};
}

async function v2(portable, database) {
	// Short on purpose: v2 predates the length policy; any non-empty one opens.
	const passphrase = "v2 pass";
	const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
	const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
	const header = {
		format: "almamesh-backup",
		formatVersion: 2,
		app: { version: "0.9.0" },
		exportedAt: NOW,
		encryption: "aes-gcm",
		kdf: {
			name: "PBKDF2",
			hash: "SHA-256",
			iterations: 600_000,
			salt: b64(salt),
		},
		iv: b64(iv),
	};
	const aad = new TextEncoder().encode(
		JSON.stringify([
			header.format,
			header.formatVersion,
			header.app.version,
			header.exportedAt,
			header.encryption,
			header.kdf.name,
			header.kdf.hash,
			header.kdf.iterations,
			header.kdf.salt,
			header.iv,
		]),
	);
	const plaintext = new TextEncoder().encode(
		JSON.stringify({ database: b64(database), settings: {} }),
	);
	const subtle = webcrypto.subtle;
	const base = await subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveKey"],
	);
	const key = await subtle.deriveKey(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 },
		base,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt"],
	);
	const ciphertext = new Uint8Array(
		await subtle.encrypt(
			{ name: "AES-GCM", iv, additionalData: aad },
			key,
			plaintext,
		),
	);
	const file = { ...header, ciphertext: b64(ciphertext) };
	const opened = await portable.openPortableBundle(file, passphrase);
	check(
		equal(opened.database, database),
		"v2 reopen with the current almamesh reader",
	);
	const bytes = new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`);
	return {
		name: "almamesh-backup-v2.json",
		bytes,
		format: "almamesh-backup-v2",
		passphrase,
		iterations: 600_000,
		plaintext,
	};
}

async function v1(backupCrypto) {
	// Typed in NFD on purpose: the legacy writers never normalized.
	const passphrase = "Ünïcödé v1 pässphrase".normalize("NFD");
	const stores = {
		"almamesh-profiles": {
			version: 3,
			state: { profiles: [{ id: "p1", name: "Asha" }] },
		},
	};
	const plain = {
		format: "almamesh-backup",
		formatVersion: 1,
		app: { version: "0.5.0" },
		exportedAt: NOW,
		encryption: "none",
		stores,
	};
	const envelope = await backupCrypto.encodeEnvelope(plain, passphrase);
	const decoded = await backupCrypto.decodeEnvelope(envelope, passphrase);
	check(JSON.stringify(decoded.stores) === JSON.stringify(stores), "v1 reopen");
	check(envelope.kdf.iterations === 210_000, "v1 stores 210,000 iterations");
	const bytes = new TextEncoder().encode(
		`${JSON.stringify(envelope, null, 2)}\n`,
	);
	const plaintext = new TextEncoder().encode(JSON.stringify(stores));
	return {
		name: "almamesh-backup-v1.json",
		bytes,
		format: "almamesh-backup-v1",
		passphrase,
		iterations: 210_000,
		plaintext,
	};
}

async function installKey(exporter, avow) {
	const passphrase = "aml install key passphrase";
	const seed = new Uint8Array(32).map((_, i) => (i * 7 + 3) % 256);
	const seedHex = Buffer.from(seed).toString("hex");
	const publicKeyHex = await avow.publicKeyHex(seedHex);
	const text = await exporter.sealInstallKeyExport(
		seedHex,
		publicKeyHex,
		passphrase,
	);
	// exported_at is outside the AAD; pin it so reruns are byte-identical.
	const file = { ...JSON.parse(text), exported_at: NOW };
	const fileText = JSON.stringify(file, null, 2);
	const opened = await exporter.openInstallKeyExport(fileText, passphrase);
	check(
		opened.seedHex === seedHex && opened.publicKeyHex === publicKeyHex,
		"install key reopen",
	);
	return {
		name: "amlfilter-install-key-v1.json",
		bytes: new TextEncoder().encode(`${fileText}\n`),
		format: "amlfilter-install-key-v1",
		passphrase,
		iterations: 600_000,
		plaintext: seed,
	};
}

const server = await createServer({
	configFile: false,
	logLevel: "error",
	plugins: [stubPlugin],
	server: { middlewareMode: true, hmr: false, fs: { strict: false } },
	optimizeDeps: { noDiscovery: true },
});
try {
	const portable = await server.ssrLoadModule(join(STORE, "portableBundle.ts"));
	const backupCrypto = await server.ssrLoadModule(
		join(STORE, "backupCrypto.ts"),
	);
	const exporter = await server.ssrLoadModule(INSTALL_KEY);
	const avow = await server.ssrLoadModule(STUBS.avow);
	const database = fakeDatabase();
	const fixtures = [
		await v3(portable, database),
		await v2(portable, database),
		await v1(backupCrypto),
		await installKey(exporter, avow),
	];
	mkdirSync(OUT, { recursive: true });
	for (const fixture of fixtures)
		writeFileSync(join(OUT, fixture.name), fixture.bytes);
	const manifest = {
		generatedBy: "scripts/generate-legacy-seal-fixtures.mjs",
		fixtures: fixtures.map((f) => ({
			file: f.name,
			format: f.format,
			passphrase: f.passphrase,
			iterations: f.iterations,
			plaintextSha256: sha256(f.plaintext),
		})),
	};
	writeFileSync(
		join(OUT, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	process.stdout.write(
		`wrote ${fixtures.length} fixtures to ${OUT}; each reopened with the current app reader\n`,
	);
} finally {
	await server.close();
}
