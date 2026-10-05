import { defineConfig, devices } from "@playwright/test";

// Firefox and WebKit run the cross-browser, legacy-migration, chunk-store and
// crash-recovery proofs; Chromium runs every spec.
const CROSS_BROWSER =
	/(?:cross-browser|engine-storage|sql-legacy|sqlite-store|hot-journal|sahpool-reload)\.spec\.ts$/;

export default defineConfig({
	testDir: "test/browser",
	fullyParallel: false,
	workers: 1,
	timeout: 30_000,
	use: {
		baseURL: "http://127.0.0.1:4177",
		headless: true,
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"] } },
		{
			name: "firefox",
			use: { ...devices["Desktop Firefox"] },
			testMatch: CROSS_BROWSER,
		},
		{
			name: "webkit",
			use: { ...devices["Desktop Safari"] },
			testMatch: CROSS_BROWSER,
		},
	],
	webServer: {
		command: "vite --host 127.0.0.1 --port 4177 --strictPort",
		url: "http://127.0.0.1:4177/test/browser/fixture.html",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
