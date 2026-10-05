// @vitest-environment node
//
// The published artefact is not the source tree, and the difference is where
// this package can lie. `files: ["dist"]` means consumers get ONLY the build
// output, so anything that is true of src/ and false of dist/ is a defect that
// no source-level test can see.
//
// Two such claims exist and both are checked here against real build output:
//
//   1. The opt-in spawnEngineClient() resolves a Worker URL from a plain literal.
//      tsc emits that literal verbatim, so it names `./worker.js` — a file that
//      exists only AFTER a build. Get it wrong and nothing throws: the URL
//      resolves to a 404 and the Worker silently never boots.
//      The root EngineClient module must not retain that URL, or bundlers emit an
//      unused second Worker beside a consumer-owned `?worker` entry.
//
//   2. Every path in package.json `exports` points at a file that exists.
//
// This is why the gate runs `build` BEFORE `test`.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");

const built = existsSync(DIST);
// A guard that silently skips is a guard that never guards. If dist is missing
// the gate ran out of order — say so loudly rather than reporting green.
describe("published artefact contract", () => {
	it("has build output to inspect (run `pnpm build` first)", () => {
		expect(built).toBe(true);
	});

	it("keeps Worker spawning opt-in and points it at a real built Worker", () => {
		const client = readFileSync(join(DIST, "engine", "client.js"), "utf8");
		expect(client).not.toContain("new URL");
		expect(client).not.toContain("spawnEngineClient");

		const spawn = join(DIST, "engine", "spawn.js");
		expect(existsSync(spawn)).toBe(true);
		const source = readFileSync(spawn, "utf8");
		const match = source.match(
			/new URL\(\s*"(\.[^"]+)"\s*,\s*import\.meta\.url/,
		);
		expect(
			match,
			"spawnEngineClient() must build its Worker URL from a literal",
		).not.toBe(null);
		const referenced = match?.[1] ?? "";
		expect(referenced).toBe("./worker.js");
		// The real assertion: resolve it the way the browser will.
		const onDisk = resolve(dirname(spawn), referenced);
		expect(
			existsSync(onDisk),
			`spawnEngineClient() references ${referenced}, which does not exist at ${onDisk}`,
		).toBe(true);
		expect(readFileSync(join(DIST, "engine", "spawn.d.ts"), "utf8")).toContain(
			"spawnEngineClient",
		);
	});

	it("ships the pinned SQLite vector Worker and minimal WASM assets", () => {
		const client = join(DIST, "vector", "sqlite", "client.js");
		const worker = join(DIST, "vector", "sqlite", "worker.js");
		const assets = join(DIST, "vector", "sqlite", "assets");
		expect(readFileSync(client, "utf8")).toContain(
			'new URL("./worker.js", import.meta.url)',
		);
		expect(existsSync(worker)).toBe(true);
		expect(readFileSync(worker, "utf8")).toContain(
			'import sqlite3InitModule from "./assets/sqlite3.mjs"',
		);
		// Both SQLite Workers hand the loader the inline OPFS async proxy, so
		// installing the OPFS VFS never waits on a network fetch.
		for (const entry of [worker, join(DIST, "sqlite", "worker.js")]) {
			expect(readFileSync(entry, "utf8")).toContain(
				"configureInlineOpfsProxy()",
			);
		}
		expect(existsSync(join(assets, "opfsAsyncProxySource.js"))).toBe(true);

		// Upstream 3.53.4 plus the local patch set documented in assets/README.md.
		const expected = [
			{
				file: "sqlite3.mjs",
				bytes: 815_058,
				sha256:
					"21d0b1fa9fafbb2c854d8dd27b6b567da97b8f74e2b3c9958deaca563f2f8b5e",
			},
			{
				file: "sqlite3.wasm",
				bytes: 932_259,
				sha256:
					"6a6f7e4b0f4249300964bd402a084387eea5df2120d2eca61bdfbff9eb226b58",
			},
			{
				file: "sqlite3-opfs-async-proxy.js",
				bytes: 42_696,
				sha256:
					"e9a55a030682ca706c7ada8cb521718c6730a2637c6f1a8b63a677a635e035f7",
			},
		] as const;
		for (const artifact of expected) {
			const path = join(assets, artifact.file);
			expect(statSync(path).size).toBe(artifact.bytes);
			expect(
				createHash("sha256").update(readFileSync(path)).digest("hex"),
			).toBe(artifact.sha256);
		}
		for (const notice of [
			"LICENSE.sqlite.md",
			"LICENSE.sqlite-vector.md",
			"THIRD_PARTY_NOTICES.md",
		]) {
			expect(existsSync(join(assets, notice))).toBe(true);
		}
	});

	it("ships the typed SQLite state Worker against the same pinned runtime", () => {
		const client = join(DIST, "sqlite", "client.js");
		const worker = join(DIST, "sqlite", "worker.js");
		expect(readFileSync(client, "utf8")).toContain(
			'new URL("./worker.js", import.meta.url)',
		);
		expect(readFileSync(worker, "utf8")).toContain(
			'import sqlite3InitModule from "../vector/sqlite/assets/sqlite3.mjs"',
		);
		expect(readFileSync(join(DIST, "sqlite", "index.d.ts"), "utf8")).toContain(
			"createSqliteStateStore",
		);
	});

	it("keeps the SQLite WASM lazy and free of network imports", async () => {
		for (const entrypoint of [
			join(DIST, "index.js"),
			join(DIST, "vector", "index.js"),
		]) {
			const source = readFileSync(entrypoint, "utf8");
			expect(source).not.toMatch(/sqlite3|vector\/sqlite|sqlite-vector/i);
		}

		const wasm = readFileSync(
			join(DIST, "vector", "sqlite", "assets", "sqlite3.wasm"),
		);
		const module = await WebAssembly.compile(wasm);
		const imports = WebAssembly.Module.imports(module).map(
			(entry) => `${entry.module}:${entry.name}`,
		);
		expect(imports).not.toContainEqual(
			expect.stringMatching(/socket|sock_|websocket|fetch|http/i),
		);
	});

	it("every package.json export resolves to a real file", () => {
		const pkg = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		) as {
			exports: Record<string, Record<string, string> | string>;
		};
		const targets: string[] = [];
		for (const entry of Object.values(pkg.exports)) {
			if (typeof entry === "string") {
				targets.push(entry);
			} else {
				targets.push(...Object.values(entry));
			}
		}
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			const onDisk = join(ROOT, target);
			expect(existsSync(onDisk), `exports -> ${target} is missing`).toBe(true);
		}
	});

	it("loads every side-effect-free JavaScript export with native ESM", async () => {
		for (const target of [
			"dist/index.js",
			"dist/engine/spawn.js",
			"dist/vector/index.js",
			"dist/vector/sqlite/index.js",
			"dist/vector/sqlite/node.js",
			"dist/sqlite/index.js",
			"dist/sql/index.js",
			"dist/sql/node.js",
		]) {
			const url = pathToFileURL(join(ROOT, target)).href;
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`await import(${JSON.stringify(url)})`,
				],
				{ encoding: "utf8" },
			);
			expect(result.status, `${target}: ${result.stderr}`).toBe(0);
		}
	});

	it("builds from an exact Git checkout under npm before dependency install", () => {
		const pkg = JSON.parse(
			readFileSync(join(ROOT, "package.json"), "utf8"),
		) as {
			files?: readonly string[];
			scripts?: Record<string, string>;
		};
		expect(pkg.scripts?.prepare).toBe("npm run build");
		expect(pkg.files).toEqual(["dist"]);
	});

	it("ships no node: import in browser entrypoints", () => {
		// The fixture loader reads node:fs. It is test-only and tsconfig.build
		// excludes it; this proves the exclusion held rather than trusting it.
		const walk = (dir: string): string[] => {
			const { readdirSync } = require("node:fs") as typeof import("node:fs");
			return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
				const full = join(dir, entry.name);
				return entry.isDirectory()
					? walk(full)
					: full.endsWith(".js")
						? [full]
						: [];
			});
		};
		const nodeOnlyEntrypoints = [
			join(DIST, "vector", "sqlite", "node.js"),
			join(DIST, "sql", "node.js"),
		];
		const offenders = walk(DIST).filter(
			(file) =>
				!nodeOnlyEntrypoints.includes(file) &&
				/from\s*"node:|require\("node:/.test(readFileSync(file, "utf8")),
		);
		expect(offenders).toEqual([]);
		for (const entry of nodeOnlyEntrypoints) {
			expect(readFileSync(entry, "utf8")).toContain('from "node:fs/promises"');
		}
	});
});
