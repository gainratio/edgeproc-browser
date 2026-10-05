/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

// jsdom, because this package's subject IS the browser boundary: OPFS, Worker
// message plumbing, BroadcastChannel, PerformanceObserver. The suite is
// self-contained — src/engine/__fixtures__/bundle is a real signed bundle
// committed into the package, so no test reads anything outside this repo.
export default defineConfig({
	test: {
		environment: "jsdom",
		globals: false,
		include: ["src/**/*.test.ts", "test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json-summary"],
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/**/__fixtures__/**",
				// Barrel export (no executable logic).
				"src/index.ts",
				// Type-only modules.
				"src/engine/types.ts",
				"src/engine/protocol.ts",
				// Test-only fixture loader (node:fs; never shipped).
				"src/engine/fixtures.ts",
				// The Worker ENTRY module. It is a top-level side effect —
				// installing the sentinel and registering onmessage — so importing
				// it under jsdom would run it, not test it. Its behaviour is
				// covered where it is real: the consumers' Playwright tiers drive
				// a genuine Worker. Counting it here would be measuring shape.
				"src/engine/worker.ts",
				// Same boundary for the SQLite adapter: real Worker + OPFS behavior is
				// exercised in test/browser/sqlite-vector.spec.ts under Chromium.
				"src/vector/sqlite/worker.ts",
				"src/sqlite/worker.ts",
				"src/sql/worker.ts",
				// Type-only worker message contracts.
				"src/vector/sqlite/protocol.ts",
				"src/sqlite/protocol.ts",
				"src/sql/protocol.ts",
				"src/sql/index.ts",
				"src/**/*.d.ts",
				"src/**/*.d.mts",
				// Worker-only SQLite loader (Worker globals, OPFS); proven by the
				// Playwright specs in Chromium, Firefox and WebKit.
				"src/sql/workerRuntime.ts",
			],
			// Floors, not aspirations: these are the MEASURED numbers rounded
			// down, so the gate fails the moment coverage slips. They are a
			// ratchet — raise them when a PR earns it, never lower them.
			thresholds: {
				lines: 90,
				statements: 90,
				functions: 90,
				branches: 85,
			},
		},
	},
});
