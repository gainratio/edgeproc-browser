import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = readFileSync(
	join(ROOT, "scripts", "build-sqlite-vector-wasm.sh"),
	"utf8",
);
const ASSETS_README = readFileSync(
	join(ROOT, "src", "vector", "sqlite", "assets", "README.md"),
	"utf8",
);

// emscripten/emsdk:6.0.11 multi-arch manifest list (released 2026-10-02).
const EMSDK_6_0_11 =
	"emscripten/emsdk@sha256:cdefec943f04fd4b2b2fe23b0a1a346be9fc560ef5784a83faa27dd351381372";

describe("SQLite WASM toolchain pin", () => {
	it("builds with the digest-pinned Emscripten 6.0.11 image", () => {
		expect(SCRIPT).toContain(`EMSDK_IMAGE=${EMSDK_6_0_11}\n`);
	});

	it("documents the same Emscripten version and digest it builds with", () => {
		expect(ASSETS_README).toContain(
			`| Emscripten | 6.0.11 | image \`${EMSDK_6_0_11}\` |`,
		);
	});

	// SQLite's build runs wasm-opt with --all-features. Binaryen 133 (emsdk
	// 6.x) then emits the compact-imports encoding (import kind 0x7f), which
	// no shipping browser can compile. The flag must come after --all-features.
	it("keeps the compact-imports encoding out of sqlite3.wasm", () => {
		expect(SCRIPT).toMatch(
			/exec \/emsdk\/upstream\/bin\/wasm-opt \\"\\\$@\\" --disable-compact-imports/,
		);
		expect(SCRIPT).toContain("bin.wasm-opt=/work/wasm-opt");
	});

	// Emscripten 6.0.2+ dropped wasmBinary from the default incoming Module
	// API. The Node entry (src/vector/sqlite/node.ts) and sqlite3.d.mts hand
	// the loader wasmBinary, so the build must opt back in for both outputs.
	it("keeps Module.wasmBinary in the loader's incoming API", () => {
		for (const build of ["vanilla", "bundler"]) {
			expect(SCRIPT).toContain(
				`"emcc.flags.${build}=-sINCOMING_MODULE_JS_API=$INCOMING_MODULE_JS_API"`,
			);
		}
		expect(SCRIPT).toMatch(/^INCOMING_MODULE_JS_API=.*\bwasmBinary\b/m);
	});

	it("strips with the image's own llvm-strip, not an apt-installed wabt", () => {
		expect(SCRIPT).toContain("bin.wasm-strip=/emsdk/upstream/bin/llvm-strip");
		expect(SCRIPT).not.toMatch(/apt-get/);
	});
});
