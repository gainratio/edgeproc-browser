// @vitest-environment node
//
// Failures that are not the user's fault must never read as a wrong passphrase.
// scrypt holds 128-256 MiB; on a low-memory phone the allocation fails with a
// RangeError (V8, WebKit) or an InternalError (Firefox). These tests inject
// those errors into the real age library's Encrypter/Decrypter.
import { Decrypter, Encrypter } from "age-encryption";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openWithPassphrase, sealWithPassphrase } from "./age.js";

const PASS = "correct horse battery staple";
const PAYLOAD = new TextEncoder().encode("payload");

async function sealed(): Promise<Uint8Array> {
	const result = await sealWithPassphrase(PAYLOAD, PASS, { workFactor: 10 });
	if (!result.ok) throw new Error(`seal failed: ${result.reason}`);
	return result.bytes;
}

function internalError(message: string): Error {
	const error = new Error(message);
	error.name = "InternalError";
	return error;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openWithPassphrase on a failing device", () => {
	it.each([
		["V8", new RangeError("Array buffer allocation failed")],
		["WebKit", new RangeError("Out of memory")],
		["Firefox", internalError("out of memory")],
	])(
		"reports scrypt running out of memory (%s) as out_of_memory, not a wrong passphrase",
		async (_, error) => {
			const file = await sealed();
			vi.spyOn(Decrypter.prototype, "decrypt").mockRejectedValue(error);
			expect(await openWithPassphrase(file, PASS)).toEqual({
				ok: false,
				reason: "out_of_memory",
			});
		},
	);

	it("stops at the first out-of-memory instead of retrying another spelling", async () => {
		const file = await sealed();
		const decrypt = vi
			.spyOn(Decrypter.prototype, "decrypt")
			.mockRejectedValue(new RangeError("Out of memory"));
		const nfd = "crème brûlée".normalize("NFD");
		expect(await openWithPassphrase(file, nfd)).toEqual({
			ok: false,
			reason: "out_of_memory",
		});
		expect(decrypt).toHaveBeenCalledTimes(1);
	});

	it("reports an undocumented library error as unavailable, not a wrong passphrase", async () => {
		const file = await sealed();
		vi.spyOn(Decrypter.prototype, "decrypt").mockRejectedValue(
			new TypeError("something new inside the library"),
		);
		expect(await openWithPassphrase(file, PASS)).toEqual({
			ok: false,
			reason: "unavailable",
		});
	});

	it("reports a non-Error throw as unavailable", async () => {
		const file = await sealed();
		vi.spyOn(Decrypter.prototype, "decrypt").mockRejectedValue("boom");
		expect(await openWithPassphrase(file, PASS)).toEqual({
			ok: false,
			reason: "unavailable",
		});
	});

	it("reports a scrypt stanza with a bad salt as malformed, not a wrong passphrase", async () => {
		const latin = new TextDecoder("latin1").decode(await sealed());
		const edited = latin.replace(/^(-> scrypt )\S+( \d+)$/m, "$1AAAA$2");
		const file = Uint8Array.from(edited, (c) => c.charCodeAt(0));
		expect(await openWithPassphrase(file, PASS)).toEqual({
			ok: false,
			reason: "malformed",
		});
	});

	it("still opens the file with the correct passphrase when nothing fails", async () => {
		expect(await openWithPassphrase(await sealed(), PASS)).toEqual({
			ok: true,
			bytes: PAYLOAD,
		});
	});
});

describe("sealWithPassphrase on a failing device", () => {
	it("reports scrypt running out of memory as out_of_memory instead of throwing", async () => {
		vi.spyOn(Encrypter.prototype, "encrypt").mockRejectedValue(
			new RangeError("Array buffer allocation failed"),
		);
		expect(await sealWithPassphrase(PAYLOAD, PASS)).toEqual({
			ok: false,
			reason: "out_of_memory",
		});
	});

	it("reports any other library error as unavailable instead of throwing", async () => {
		vi.spyOn(Encrypter.prototype, "encrypt").mockRejectedValue(
			new Error("unexpected"),
		);
		expect(await sealWithPassphrase(PAYLOAD, PASS)).toEqual({
			ok: false,
			reason: "unavailable",
		});
	});
});

describe("classifying the library's own errors", () => {
	// The message list in age.ts is the only signal typage gives. Damage every
	// region of real files: each result must be tampered or malformed. A
	// message the list misses would surface here as `unavailable`.
	it("never reports a damaged file as unavailable or out_of_memory", async () => {
		const reasons = new Set<string>();
		for (const size of [0, 65_600]) {
			const plain = new Uint8Array(size);
			const result = await sealWithPassphrase(plain, PASS, { workFactor: 10 });
			if (!result.ok) throw new Error(result.reason);
			const file = result.bytes;
			const step = Math.max(1, Math.floor(file.length / 60));
			const damaged: Uint8Array[] = [];
			for (let i = 0; i < file.length; i += step) {
				for (const bit of [0x01, 0x80]) {
					const copy = file.slice();
					copy[i] = (copy[i] ?? 0) ^ bit;
					damaged.push(copy);
				}
			}
			for (let cut = 1; cut < 400; cut += 23) {
				damaged.push(file.slice(0, file.length - cut));
			}
			for (const bytes of damaged) {
				const opened = await openWithPassphrase(bytes, PASS);
				reasons.add(opened.ok ? "ok" : opened.reason);
			}
		}
		expect(reasons.has("wrong_passphrase_or_tampered")).toBe(true);
		expect(reasons.has("malformed")).toBe(true);
		expect(reasons.has("unavailable")).toBe(false);
		expect(reasons.has("out_of_memory")).toBe(false);
	}, 30_000);
});
