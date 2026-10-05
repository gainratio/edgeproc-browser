// Real-browser proof of cacheFallback: the engine Worker runs with OPFS
// refused. "none" must reject at once with EngineStorageUnavailableError and
// download nothing; the default "memory" still syncs into RAM, which proves
// the refusal is real and the option is what changes the outcome.

import {
	type EngineCacheFallback,
	EngineClient,
	EngineOperationError,
	EngineStorageUnavailableError,
} from "@gainratio/browser";

export interface EngineRefusalResult {
	readonly outcome: string;
	readonly typed: boolean;
	readonly code: string | null;
	readonly reason: string | null;
	readonly elapsedMs: number;
}

declare global {
	interface Window {
		runEngineRefusal(
			namespace: string,
			cacheFallback?: EngineCacheFallback,
		): Promise<EngineRefusalResult>;
	}
}

const CATALOG = "/bundle-origin";
// The committed bundle's raw public key (see engine-fixture.ts).
const BUNDLE_PUBLIC_KEY =
	"a54f579302474524d95bc5363818f81852a928dfc5974f7c87a331fd4faa12ce";

function rawKeyUrl(): string {
	const bytes = new Uint8Array(
		(BUNDLE_PUBLIC_KEY.match(/../gu) ?? []).map((pair) =>
			Number.parseInt(pair, 16),
		),
	);
	return URL.createObjectURL(new Blob([bytes]));
}

window.runEngineRefusal = async (namespace, cacheFallback) => {
	const client = new EngineClient(
		new Worker(new URL("./engine-refused-worker.ts", import.meta.url), {
			type: "module",
		}),
		{ idleTimeoutMs: 60_000 },
	);
	const started = performance.now();
	try {
		const result = await client.sync(CATALOG, rawKeyUrl(), {
			cacheNamespace: namespace,
			wantedPaths: ["catalog_meta.json"],
			...(cacheFallback === undefined ? {} : { cacheFallback }),
		});
		return {
			outcome: `synced:${result.cacheBackend}`,
			typed: false,
			code: null,
			reason: null,
			elapsedMs: performance.now() - started,
		};
	} catch (error) {
		return {
			outcome: error instanceof Error ? error.name : String(error),
			typed: error instanceof EngineStorageUnavailableError,
			code: error instanceof EngineOperationError ? error.code : null,
			reason:
				error instanceof EngineStorageUnavailableError ? error.reason : null,
			elapsedMs: performance.now() - started,
		};
	} finally {
		client.dispose();
	}
};
