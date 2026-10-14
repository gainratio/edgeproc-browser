// @vitest-environment node
//
// The release gate publish.yml runs before it may mint an npm credential.
// 0.2.1 shipped from a commit whose CI was red, because a `v*` tag push was
// the whole trigger. Every refusal is driven here, and so is the accept case:
// a gate that refuses everything also passes a reject-only suite.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	evaluateRelease,
	githubApi,
	main,
	verifyRelease,
} from "../scripts/verify-release-tag.mjs";

const SHA = "a".repeat(40);

function run(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		run_number: 10,
		head_sha: SHA,
		event: "push",
		head_branch: "main",
		status: "completed",
		conclusion: "success",
		html_url: "https://github.com/o/r/actions/runs/1",
		...overrides,
	};
}

function good(overrides: Record<string, unknown> = {}) {
	return {
		tag: "v0.2.2",
		packageVersion: "0.2.2",
		sha: SHA,
		comparison: { status: "identical" },
		ciRuns: [run()],
		...overrides,
	};
}

describe("evaluateRelease", () => {
	it("accepts a tag that matches the version, on main, with green CI", () => {
		expect(evaluateRelease(good())).toEqual([]);
		expect(evaluateRelease(good({ comparison: { status: "behind" } }))).toEqual(
			[],
		);
	});

	it.each(["0.2.2", "v0.2.1", "v0.2.2-rc.1"])(
		"refuses tag %j for package version 0.2.2",
		(tag) => {
			expect(evaluateRelease(good({ tag }))).toEqual([
				expect.stringMatching(/does not match package\.json version "0\.2\.2"/),
			]);
		},
	);

	it.each([{ status: "ahead" }, { status: "diverged" }, {}, undefined])(
		"refuses a commit main does not contain (%j)",
		(comparison) => {
			expect(evaluateRelease(good({ comparison }))).toEqual([
				expect.stringMatching(/is not on main/),
			]);
		},
	);

	it.each([
		["failure", "completed"],
		["cancelled", "completed"],
		[null, "in_progress"],
		[null, "queued"],
	])("refuses CI that concluded %s (%s)", (conclusion, status) => {
		expect(
			evaluateRelease(good({ ciRuns: [run({ conclusion, status })] })),
		).toEqual([expect.stringMatching(/not completed\/success/)]);
	});

	it("judges the NEWEST run: an old green run cannot launder a red one", () => {
		const ciRuns = [
			run({ run_number: 9 }),
			run({ run_number: 11, conclusion: "failure" }),
		];
		expect(evaluateRelease(good({ ciRuns }))).toEqual([
			expect.stringMatching(/completed\/failure/),
		]);
	});

	it.each([
		["another commit", { head_sha: "b".repeat(40) }],
		["a pull request run", { event: "pull_request" }],
		["a run on another branch", { head_branch: "feature" }],
	])("ignores %s and refuses for lack of CI", (_label, overrides) => {
		expect(evaluateRelease(good({ ciRuns: [run(overrides)] }))).toEqual([
			expect.stringMatching(/no ci\.yml push run on main/),
		]);
	});

	it("refuses with no runs at all (missing or malformed list)", () => {
		expect(evaluateRelease(good({ ciRuns: [] }))).toHaveLength(1);
		expect(evaluateRelease(good({ ciRuns: undefined }))).toHaveLength(1);
	});

	it("reports every failure, not just the first", () => {
		expect(
			evaluateRelease(
				good({ tag: "v9", comparison: { status: "ahead" }, ciRuns: [] }),
			),
		).toHaveLength(3);
	});
});

describe("verifyRelease + githubApi", () => {
	it("asks GitHub for main...sha and this SHA's ci.yml push runs", async () => {
		const paths: string[] = [];
		const failures = await verifyRelease({
			repo: "o/r",
			sha: SHA,
			tag: "v0.2.2",
			packageVersion: "0.2.2",
			api: async (path: string) => {
				paths.push(path);
				return path.includes("/compare/")
					? { status: "identical" }
					: { workflow_runs: [run()] };
			},
		});
		expect(failures).toEqual([]);
		expect(paths.sort()).toEqual([
			`/repos/o/r/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=push&branch=main&per_page=100`,
			`/repos/o/r/compare/main...${SHA}`,
		]);
	});

	it("sends the token and throws on a non-2xx answer", async () => {
		const fetchImpl = vi.fn(async () => new Response("nope", { status: 403 }));
		await expect(githubApi("t0k", fetchImpl)("/x")).rejects.toThrow(
			/GitHub API \/x answered 403/,
		);
		expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/x", {
			headers: expect.objectContaining({ authorization: "Bearer t0k" }),
		});
	});
});

describe("main (exit code is the verdict)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
		vi.restoreAllMocks();
	});

	function repoWith(version: string): string {
		const dir = mkdtempSync(join(tmpdir(), "release-gate-"));
		dirs.push(dir);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
		return dir;
	}

	const env = {
		GITHUB_TOKEN: "t",
		GITHUB_REPOSITORY: "o/r",
		GITHUB_SHA: SHA,
		GITHUB_REF_NAME: "v0.2.2",
	};

	function github(ciConclusion: string) {
		return async (url: string) =>
			Response.json(
				url.includes("/compare/")
					? { status: "identical" }
					: { workflow_runs: [run({ conclusion: ciConclusion })] },
			);
	}

	it("exits 0 when everything checks out", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		expect(await main(env, repoWith("0.2.2"), github("success"))).toBe(0);
	});

	it("exits 1 on red CI (the 0.2.1 case)", async () => {
		const errors = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		expect(await main(env, repoWith("0.2.2"), github("failure"))).toBe(1);
		expect(errors).toHaveBeenCalledWith(
			expect.stringMatching(/^release refused: .*completed\/failure/),
		);
	});

	it("exits 1, failing closed, when the environment or API is missing", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		expect(
			await main(
				{ ...env, GITHUB_TOKEN: "" },
				repoWith("0.2.2"),
				github("success"),
			),
		).toBe(1);
		const down = async () => {
			throw new Error("network down");
		};
		expect(await main(env, repoWith("0.2.2"), down)).toBe(1);
	});
});

describe("publish.yml wiring", () => {
	const workflow = readFileSync(
		new URL("../.github/workflows/publish.yml", import.meta.url),
		"utf8",
	);
	const jobsFrom = (name: string): string => {
		const start = workflow.indexOf(`\n  ${name}:\n`);
		return start === -1 ? "" : workflow.slice(start);
	};
	const publishJob = (): string => jobsFrom("publish");
	const buildJob = (): string => {
		const build = jobsFrom("build");
		const end = build.indexOf("\n  publish:\n");
		return end === -1 ? build : build.slice(0, end);
	};

	it("runs the gate script in its own job", () => {
		expect(workflow).toMatch(/^ {2}release-gate:$/m);
		expect(workflow).toMatch(/run: node scripts\/verify-release-tag\.mjs/);
		expect(workflow).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
		expect(workflow).toMatch(/actions: read/);
	});

	it("publishes only inside the protected npm-release environment", () => {
		// The gate runs from the TAGGED commit's workflow, so a tag on an
		// unreviewed commit can edit it away. The environment (required reviewer,
		// v* tag policy) and npm's trusted publisher bound to it are what a
		// workflow edit cannot remove.
		const publish = workflow.slice(workflow.indexOf("\n  publish:"));
		expect(publish).toMatch(/^ {4}environment: npm-release$/m);
	});

	it("publishes inline, not through ci's retired ts-publish brick", () => {
		// The brick nested an hseshadr/ci action ref, which stopped resolving when
		// ci moved to gainratio. An inline job is the only call shape left.
		const publish = workflow.slice(workflow.indexOf("\n  publish:"));
		expect(workflow).not.toContain("ts-publish.yml@");
		expect(publish).toMatch(/^ {6}id-token: write/m);
		expect(publish).toContain("npm publish");
		// A green publish is not a release: the job must ask the registry.
		expect(publish).toMatch(/npm view "\$\{name\}@\$\{version\}" version/);
	});

	it("makes the OIDC publish job depend on it, through the build job", () => {
		expect(buildJob()).toMatch(/^ {4}needs: release-gate$/m);
		expect(publishJob()).toMatch(/^ {4}needs: build$/m);
	});

	// PRIVILEGE SPLIT. `id-token: write` IS the npm credential. Any code that runs
	// in the job holding it can mint that token and publish anything. Installing
	// dependencies (with every postinstall allowed), running the gate and building
	// all execute third-party code, so they live in a read-only `build` job that
	// hands a packed tarball across. The publish job runs only npm itself.
	it("grants id-token: write to the publish job alone", () => {
		expect(workflow.match(/^ +id-token: write/gm)).toHaveLength(1);
		expect(publishJob()).toMatch(/^ {6}id-token: write/m);
	});

	it("builds and packs in a read-only job that uploads the tarball", () => {
		const build = buildJob();
		expect(build).toMatch(/^ {6}contents: read$/m);
		expect(build).not.toMatch(/write/);
		expect(build).toContain("pnpm gate");
		expect(build).toContain("npm pack");
		expect(build).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40}/);
	});

	it("runs no checkout and no dependency code in the id-token job", () => {
		const publish = publishJob();
		expect(publish).not.toMatch(/actions\/checkout@|pnpm|npm ci|npm run|npx /);
		expect(publish).toMatch(/uses: actions\/download-artifact@[0-9a-f]{40}/);
		expect(publish).toMatch(
			/npm publish "\$tarball" --access public --provenance/,
		);
	});

	it("pins the publishing npm to an exact OIDC-capable version, never @latest", () => {
		expect(workflow).not.toContain("npm@latest");
		const installs = [...workflow.matchAll(/(?<![\w-])npm install[^\n]*/g)].map(
			(m) => m[0],
		);
		expect(installs).not.toEqual([]);
		for (const line of installs) {
			const v =
				/^npm install --global --ignore-scripts npm@(\d+)\.(\d+)\.(\d+)$/.exec(
					line,
				);
			expect(v, line).not.toBeNull();
			const [major = 0, minor = 0, patch = 0] = (v ?? []).slice(1).map(Number);
			// OIDC trusted publishing needs npm >= 11.5.1.
			expect(major * 1e6 + minor * 1e3 + patch, line).toBeGreaterThanOrEqual(
				11_005_001,
			);
		}
	});
});
