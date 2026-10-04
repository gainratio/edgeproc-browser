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
				// ── A NAMED GAP, NOT A CLEAN EXCLUSION ────────────────────────
				// opfsStore.ts is 300 lines and this suite reaches 57% of them.
				// The rest is the OPFS sync-access-handle path, which jsdom has
				// no implementation of at all — there is nothing to fake that
				// would prove anything about the real API's locking semantics.
				// It is excluded so the number for everything else is honest,
				// NOT because it is covered. It is not.
				// What this means concretely: `createSyncAccessHandle` contention,
				// the nav-release race, and partial-write recovery are unproven
				// by this package. They are exercised downstream in edge-reco's
				// Playwright c1/offline tiers against a real browser.
				// FOLLOW-UP: this package needs its own real-browser tier
				// (vitest browser mode or Playwright) before opfsStore can carry
				// a coverage claim. Tracked in README "Known gaps".
				"src/engine/opfsStore.ts",
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
