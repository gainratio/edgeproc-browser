import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { defineConfig, type Plugin } from "vite";

const FIXTURE_BUNDLE = join(
	import.meta.dirname,
	"src",
	"engine",
	"__fixtures__",
	"bundle",
);

// Serves the committed signed bundle over real HTTP at /__bundle/ (Vite's own
// static serving refuses the *.key trust root). No Playwright interception,
// so the throughput proof times the browser, not the test's route handler.
function fixtureBundle(): Plugin {
	return {
		name: "edgeproc-test-fixture-bundle",
		configureServer(server) {
			server.middlewares.use("/__bundle/", (request, response, next) => {
				const relative = normalize(
					decodeURIComponent((request.url ?? "").split("?")[0] ?? ""),
				);
				if (relative.includes("..")) {
					response.statusCode = 400;
					response.end();
					return;
				}
				readFile(join(FIXTURE_BUNDLE, relative)).then(
					(body) => {
						response.setHeader("content-type", "application/octet-stream");
						response.setHeader("cross-origin-resource-policy", "same-origin");
						response.end(body);
					},
					() => next(),
				);
			});
		},
	};
}

// Test-only control surface for the Chromium proofs. SQLite's OPFS VFS used
// to be installed by spawning its async proxy from a URL: a network fetch
// raced against a hard-coded 4 s timer inside sqlite3.mjs. On a saturated
// link (slow 4G, eight chunk fetches in flight) the fetch lost, the VFS was
// silently skipped and the state database could not open. This plugin lets a
// test hold that script on the server for a chosen time and count how often
// it is requested, so the proof can show the install no longer needs it.
function opfsProxyProbe(): Plugin {
	let holdMs = 0;
	let requests = 0;
	return {
		name: "edgeproc-test-opfs-proxy-probe",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				// Vite's 304 Not Modified drops the COEP/COOP headers below, and
				// WebKit then refuses the cached worker module ("blocked by
				// Cross-Origin-Embedder-Policy"). Always answer 200 with them.
				delete request.headers["if-none-match"];
				delete request.headers["if-modified-since"];
				const url = request.url ?? "";
				if (url.startsWith("/__test/opfs-proxy")) {
					const hold = new URL(url, "http://127.0.0.1").searchParams.get(
						"hold",
					);
					if (hold !== null) {
						holdMs = Number(hold);
						requests = 0;
					}
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify({ holdMs, requests }));
					return;
				}
				if (url.includes("sqlite3-opfs-async-proxy")) {
					requests += 1;
					if (holdMs > 0) {
						setTimeout(next, holdMs);
						return;
					}
				}
				next();
			});
		},
	};
}

// SQLite's official multi-tab opfs-wl VFS requires SharedArrayBuffer. These
// headers make the real-browser fixture match the documented deployment
// contract instead of testing a capability consumers would not have.
export default defineConfig({
	plugins: [opfsProxyProbe(), fixtureBundle()],
	server: {
		headers: {
			"Cross-Origin-Embedder-Policy": "require-corp",
			"Cross-Origin-Opener-Policy": "same-origin",
		},
	},
});
