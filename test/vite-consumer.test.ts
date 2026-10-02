// @vitest-environment node
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const scratch: string[] = [];

afterEach(() => {
	for (const directory of scratch.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("Vite consumer Worker contract", () => {
	it("builds a consumer-owned Worker entry through the public worker export", async () => {
		const root = mkdtempSync(join(tmpdir(), "edgeproc-vite-consumer-"));
		scratch.push(root);
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "node_modules", "@gainratio"), { recursive: true });
		symlinkSync(
			ROOT,
			join(root, "node_modules", "@gainratio", "browser"),
			"dir",
		);
		writeFileSync(
			join(root, "index.html"),
			'<main id="app"></main><script type="module" src="/src/main.ts"></script>',
		);
		writeFileSync(
			join(root, "src", "edgeproc.worker.ts"),
			'import "@gainratio/browser/worker";\n',
		);
		writeFileSync(
			join(root, "src", "main.ts"),
			[
				'import { EngineClient } from "@gainratio/browser";',
				'import EdgeProcWorker from "./edgeproc.worker?worker";',
				"const client = new EngineClient(new EdgeProcWorker());",
				"client.dispose();",
			].join("\n"),
		);

		await build({
			root,
			configFile: false,
			logLevel: "silent",
			build: { outDir: "out" },
			worker: { format: "es" },
		});

		const assets = readdirSync(join(root, "out", "assets"));
		const javascript = assets
			.filter((name) => name.endsWith(".js"))
			.map((name) => readFileSync(join(root, "out", "assets", name), "utf8"));
		expect(javascript.length).toBeGreaterThanOrEqual(2);
		const engineWorkers = javascript.filter((source) =>
			source.includes("engine-worker"),
		);
		expect(engineWorkers).toHaveLength(1);
		expect(javascript.join("\n")).not.toContain('new URL("./worker.js"');
	});
});
