// Runs the /seal entry inside a dedicated Worker, the way the docs tell apps to
// call it (scrypt is synchronous and holds 128 MiB at the default work factor).
import {
	DEFAULT_SCRYPT_WORK_FACTOR,
	isSealed,
	openLegacyPbkdf2AesGcm,
	openWithPassphrase,
	sealWithPassphrase,
} from "@gainratio/browser/seal";

export interface SealWorkerRequest {
	readonly payloadBytes: number;
	readonly legacy: ReadonlyArray<{
		readonly url: string;
		readonly passphrase: string;
	}>;
}

export interface SealWorkerProof {
	readonly workFactor: number;
	readonly sealMs: number;
	readonly openMs: number;
	readonly sealedBytes: number;
	readonly isSealed: boolean;
	readonly roundTrip: boolean;
	readonly wrongPassphrase: string;
	readonly tampered: string;
	readonly legacy: ReadonlyArray<string>;
}

const PASS = "correct horse battery staple";

function payload(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let offset = 0; offset < size; offset += 65_536) {
		crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
	}
	return bytes;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function openLegacy(
	entries: SealWorkerRequest["legacy"],
): Promise<string[]> {
	const results: string[] = [];
	for (const entry of entries) {
		const bytes = new Uint8Array(await (await fetch(entry.url)).arrayBuffer());
		const opened = await openLegacyPbkdf2AesGcm(bytes, entry.passphrase);
		results.push(opened.ok ? opened.format : `refused:${opened.reason}`);
	}
	return results;
}

async function prove(request: SealWorkerRequest): Promise<SealWorkerProof> {
	const plaintext = payload(request.payloadBytes);
	const sealStart = performance.now();
	const sealed = await sealWithPassphrase(plaintext, PASS);
	const sealMs = performance.now() - sealStart;
	if (!sealed.ok) throw new Error(`seal refused: ${sealed.reason}`);
	const openStart = performance.now();
	const opened = await openWithPassphrase(sealed.bytes, PASS);
	const openMs = performance.now() - openStart;
	const wrong = await openWithPassphrase(sealed.bytes, `${PASS}!`);
	const tamperedBytes = sealed.bytes.slice();
	const last = tamperedBytes.length - 1;
	tamperedBytes[last] = (tamperedBytes[last] ?? 0) ^ 1;
	const tampered = await openWithPassphrase(tamperedBytes, PASS);
	return {
		workFactor: DEFAULT_SCRYPT_WORK_FACTOR,
		sealMs,
		openMs,
		sealedBytes: sealed.bytes.length,
		isSealed: isSealed(sealed.bytes),
		roundTrip: opened.ok && same(opened.bytes, plaintext),
		wrongPassphrase: wrong.ok ? "opened" : wrong.reason,
		tampered: tampered.ok ? "opened" : tampered.reason,
		legacy: await openLegacy(request.legacy),
	};
}

self.onmessage = async (event: MessageEvent<SealWorkerRequest>) => {
	try {
		self.postMessage({ ok: true, proof: await prove(event.data) });
	} catch (error) {
		self.postMessage({ ok: false, error: String(error) });
	}
};
