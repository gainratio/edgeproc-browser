// @vitest-environment node
//
// The age library is a lazily loaded chunk. When that chunk fails to load (a
// deploy replaced it, the network dropped), seal and open must say so with a
// typed reason, never throw and never claim the passphrase is wrong. A failed
// load must not be cached: the next call tries again.
import { beforeEach, describe, expect, it, vi } from "vitest";

const PASS = "correct horse battery staple";
const PAYLOAD = new TextEncoder().encode("payload");
const AGE_FILE = new TextEncoder().encode(
	"age-encryption.org/v1\n-> scrypt AAAAAAAAAAAAAAAAAAAAAA 10\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n--- AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n",
);
const ARMORED = new TextEncoder().encode(
	"-----BEGIN AGE ENCRYPTED FILE-----\nYWdl\n-----END AGE ENCRYPTED FILE-----\n",
);

beforeEach(() => {
	vi.resetModules();
	vi.doMock("age-encryption", () => {
		throw new Error("Failed to fetch dynamically imported module");
	});
});

async function freshAge(): Promise<typeof import("./age.js")> {
	return import("./age.js");
}

describe("when the age library cannot load", () => {
	it("seal returns unavailable instead of throwing", async () => {
		const { sealWithPassphrase } = await freshAge();
		expect(await sealWithPassphrase(PAYLOAD, PASS, { workFactor: 10 })).toEqual(
			{ ok: false, reason: "unavailable" },
		);
	});

	it("open returns unavailable, not wrong_passphrase_or_tampered", async () => {
		const { openWithPassphrase } = await freshAge();
		expect(await openWithPassphrase(AGE_FILE, PASS)).toEqual({
			ok: false,
			reason: "unavailable",
		});
	});

	it("open of an armored file returns unavailable instead of throwing", async () => {
		const { openWithPassphrase } = await freshAge();
		expect(await openWithPassphrase(ARMORED, PASS)).toEqual({
			ok: false,
			reason: "unavailable",
		});
	});

	it("retries the load on the next call after a failure", async () => {
		const { sealWithPassphrase } = await freshAge();
		expect(
			(await sealWithPassphrase(PAYLOAD, PASS, { workFactor: 10 })).ok,
		).toBe(false);
		vi.doUnmock("age-encryption");
		expect(
			(await sealWithPassphrase(PAYLOAD, PASS, { workFactor: 10 })).ok,
		).toBe(true);
	});
});
