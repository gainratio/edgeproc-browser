// @vitest-environment node
//
// Conformance: the C2SP CCTV age test vectors (npm `cctv-age`, by Filippo
// Valsorda; the same corpus typage, rage and Go age test against). Every
// passphrase vector must give the outcome the vector expects, and no vector of
// any kind may open with a passphrase or make the opener throw.
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import * as vectors from "cctv-age";
import { describe, expect, it } from "vitest";
import { openWithPassphrase } from "./age.js";

interface Vector {
	readonly name: string;
	readonly meta: ReadonlyMap<string, string>;
	readonly file: Uint8Array;
}

function parse(name: string, raw: Uint8Array): Vector {
	const latin = new TextDecoder("latin1").decode(raw);
	const split = latin.indexOf("\n\n");
	const meta = new Map(
		latin
			.slice(0, split)
			.split("\n")
			.map((line) => {
				const colon = line.indexOf(": ");
				return [line.slice(0, colon), line.slice(colon + 2)] as const;
			}),
	);
	let file = raw.subarray(split + 2);
	if (meta.get("compressed") === "zlib") file = inflateSync(file);
	return { name, meta, file };
}

const all = Object.entries(vectors).map(([name, raw]) => parse(name, raw));
const passphraseVectors = all.filter((v) => v.meta.has("passphrase"));

describe("CCTV age vectors", () => {
	it("found the scrypt vectors", () => {
		expect(passphraseVectors.length).toBeGreaterThanOrEqual(26);
	});

	it.each(passphraseVectors.map((v) => [v.name, v] as const))(
		"%s",
		async (_name, vector) => {
			const result = await openWithPassphrase(
				vector.file,
				vector.meta.get("passphrase") ?? "",
			);
			const expectation = vector.meta.get("expect");
			if (expectation === "success") {
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				const digest = createHash("sha256").update(result.bytes).digest("hex");
				expect(digest).toBe(vector.meta.get("payload"));
			} else if (expectation === "no match") {
				// A real scrypt stanza that fails is a wrong passphrase. A stanza of
				// another type (`Scrypt` is not `scrypt`) is a file for a key, not
				// a passphrase, which we report as `unsupported`.
				const hasScrypt = /^-> scrypt /m.test(
					new TextDecoder("latin1").decode(vector.file),
				);
				expect(result).toEqual({
					ok: false,
					reason: hasScrypt ? "wrong_passphrase_or_tampered" : "unsupported",
				});
			} else {
				expect(result.ok).toBe(false);
			}
		},
	);

	it("opens no public-key vector with a passphrase, and never throws", async () => {
		const others = all.filter((v) => !v.meta.has("passphrase"));
		expect(others.length).toBeGreaterThan(100);
		for (const vector of others) {
			const result = await openWithPassphrase(vector.file, "password");
			expect(result.ok, vector.name).toBe(false);
		}
	});
});
