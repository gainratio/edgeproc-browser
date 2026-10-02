import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ASSETS_DIR,
	PROXY_FILE,
	renderOpfsProxySource,
	SOURCE_MODULE,
} from "../scripts/generate-opfs-proxy-source.mjs";
import { OPFS_ASYNC_PROXY_SOURCE } from "../src/vector/sqlite/assets/opfsAsyncProxySource.js";

// The inline proxy is what the SQLite Workers actually run. If it drifted
// from the vendored asset, the dist contract (hash-pinned asset) would still
// look green while the Workers ran something else.
describe("inline OPFS async proxy source", () => {
	const asset = readFileSync(join(ASSETS_DIR, PROXY_FILE), "utf8");

	it("is the vendored proxy script, byte for byte", () => {
		expect(OPFS_ASYNC_PROXY_SOURCE).toBe(asset);
		expect(OPFS_ASYNC_PROXY_SOURCE.length).toBeGreaterThan(40_000);
	});

	it("is exactly what the generator renders from the asset", () => {
		const committed = readFileSync(join(ASSETS_DIR, SOURCE_MODULE), "utf8");
		expect(committed).toBe(renderOpfsProxySource(asset));
	});
});
