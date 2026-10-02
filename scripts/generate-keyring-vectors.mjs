#!/usr/bin/env node
// Deterministic cross-runtime keyring vectors.
//
// edge-proc (Python) and @gainratio/browser (TypeScript) must agree byte for
// byte on the key identity, the signing preimage of every VersionPointer shape,
// the signatures, and the verdicts. This script derives every value from FIXED
// seeds with RFC 8032 (deterministic) Ed25519, so it has no randomness and no
// clock: rerunning it reproduces src/engine/__fixtures__/keyring_vectors.json
// exactly, and test/keyring-vectors-script.test.ts fails if the two drift.
//
// It deliberately does NOT import the package's own canonical encoder or
// pointer code: the vectors are an independent statement of the wire contract,
// which the engine tests then have to match.
//
//   node scripts/generate-keyring-vectors.mjs          # rewrite the fixture
//   node scripts/generate-keyring-vectors.mjs --check  # exit 1 on drift

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const VECTORS_PATH = join(
	ROOT,
	"src",
	"engine",
	"__fixtures__",
	"keyring_vectors.json",
);

const SEED_A = new Uint8Array(32).fill(0x01);
const SEED_B = new Uint8Array(32).fill(0x02);
const EXPIRES_AT = 1_767_225_600; // 2026-01-01T00:00:00Z
const BASE = {
	manifest_hash: "0".repeat(64),
	version: "2026-01-01",
	bundle_id: "vectors",
	channel: "stable",
};

function hex(bytes) {
	return Buffer.from(bytes).toString("hex");
}

/** sorted keys, "," / ":" separators, no whitespace, raw UTF-8 — the same
 * rule as Python json.dumps(sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False). */
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function keyId(publicKey) {
	return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

async function signed(unsigned, secretKey) {
	const preimage = new TextEncoder().encode(canonical(unsigned));
	const signature = await signAsync(preimage, secretKey);
	return {
		pointer: {
			...unsigned,
			signature: Buffer.from(signature).toString("base64"),
		},
		preimage_hex: hex(preimage),
		signature_hex: hex(signature),
	};
}

/** Build the vectors document as its exact committed bytes. */
export async function buildKeyringVectors() {
	const publicA = await getPublicKeyAsync(SEED_A);
	const publicB = await getPublicKeyAsync(SEED_B);
	const idA = keyId(publicA);
	const idB = keyId(publicB);
	const entryA = { key_id: idA, public_key: hex(publicA) };
	const entryB = { key_id: idB, public_key: hex(publicB) };
	const schema = "edgeproc.keyring/v1";
	const document = {
		key_ids: { A: idA, B: idB },
		keyrings: {
			ab: { schema, keys: [entryA, entryB], revoked: [] },
			b_revoked_a: { schema, keys: [entryB], revoked: [idA] },
		},
		pointers: {
			a: await signed({ ...BASE, sequence: 1 }, SEED_A),
			b: await signed({ ...BASE, key_id: idA, sequence: 2 }, SEED_A),
			c: await signed({ ...BASE, key_id: idB, sequence: 3 }, SEED_B),
			d: await signed(
				{ ...BASE, key_id: idB, sequence: 4, expires_at: EXPIRES_AT },
				SEED_B,
			),
		},
		// Each pointer judged ON ITS OWN (no stored rollback floor) as a
		// network-fetched pointer under keyring b_revoked_a at Unix time `now`.
		outcomes: {
			b_revoked_a: {
				[String(EXPIRES_AT - 1)]: {
					a: "signature_error",
					b: "key_revoked",
					c: "ok",
					d: "ok",
				},
				[String(EXPIRES_AT)]: {
					a: "signature_error",
					b: "key_revoked",
					c: "ok",
					d: "expired",
				},
			},
		},
	};
	return canonical(document);
}

const invokedDirectly =
	process.argv[1] !== undefined &&
	fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
	const text = await buildKeyringVectors();
	if (process.argv.includes("--check")) {
		const committed = readFileSync(VECTORS_PATH, "utf8");
		if (committed !== text) {
			console.error(`${VECTORS_PATH} is stale; rerun without --check`);
			process.exit(1);
		}
	} else {
		writeFileSync(VECTORS_PATH, text);
	}
	console.log(createHash("sha256").update(text).digest("hex"));
}
