import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPFS_ASYNC_PROXY_SOURCE } from "./assets/opfsAsyncProxySource.js";
import {
	configureInlineOpfsProxy,
	inlineOpfsAsyncProxyUrl,
	type Sqlite3ApiConfigScope,
} from "./opfsAsyncProxy.js";

describe("configureInlineOpfsProxy", () => {
	const blobs: Blob[] = [];
	const originalCreateObjectURL = URL.createObjectURL;

	beforeEach(() => {
		// jsdom has no object URLs; record what would be registered.
		URL.createObjectURL = vi.fn((blob: Blob) => {
			blobs.push(blob);
			return `blob:null/proxy-${blobs.length}`;
		});
	});

	afterEach(() => {
		URL.createObjectURL = originalCreateObjectURL;
		blobs.length = 0;
	});

	it("hands sqlite3.mjs a Blob URL of the verbatim proxy, typed as JavaScript", async () => {
		const scope: Sqlite3ApiConfigScope = {};
		configureInlineOpfsProxy(scope);
		expect(scope.sqlite3ApiConfig?.opfsProxyUri).toMatch(/^blob:/u);
		expect(blobs[0]?.type).toBe("text/javascript");
		expect(await blobs[0]?.text()).toBe(OPFS_ASYNC_PROXY_SOURCE);
	});

	it("keeps any other config the embedding Worker set", () => {
		const scope: Sqlite3ApiConfigScope = { sqlite3ApiConfig: { warn: 1 } };
		configureInlineOpfsProxy(scope);
		expect(scope.sqlite3ApiConfig).toMatchObject({ warn: 1 });
	});

	it("creates the object URL once per Worker, not once per VFS", () => {
		const first = inlineOpfsAsyncProxyUrl();
		configureInlineOpfsProxy({});
		expect(inlineOpfsAsyncProxyUrl()).toBe(first);
	});
});
