// @vitest-environment node
//
// CLAIM: the publish path is proven on every PR. ci.yml's `publish-path` job
// runs `npm publish --dry-run` under npm@latest so prepublishOnly (preflight &&
// gate) and the pack step run exactly as the real publish runs them.
//
// npm's dry run still asks the registry whether the version exists. Between
// releases package.json names a version that IS on npm, so the dry run died
// with "You cannot publish over the previously published versions: 0.4.1" and
// main went red for a reason that says nothing about the publish path. The job
// now gives its working copy a throwaway prerelease version that cannot exist
// on npm, and never commits it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url);
const ci = readFileSync(new URL(".github/workflows/ci.yml", ROOT), "utf8");
const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8")) as {
	scripts: Record<string, string>;
};

/**
 * The version in the COMMITTED package.json. The working copy is the wrong
 * witness: inside the publish-path job it carries the override on purpose.
 */
function committedVersion(): string {
	const raw = execFileSync("git", ["show", "HEAD:package.json"], {
		cwd: fileURLToPath(ROOT),
		encoding: "utf8",
	});
	return (JSON.parse(raw) as { version: string }).version;
}

/** The `publish-path:` job body, up to the next job at the same indent. */
function publishPathJob(): string {
	const match = /^ {2}publish-path:\n((?: {4,}.*\n|\s*\n)*)/m.exec(ci);
	return match?.[1] ?? "";
}

/** The step whose `- name:` starts with `prefix`, or undefined. */
function stepOf(job: string, prefix: string): string | undefined {
	return job.split(/\n\s*- name: /).find((block) => block.startsWith(prefix));
}

const OVERRIDE = "Give the dry run an unpublished version";
const DRY_RUN = "npm publish --dry-run";

describe("CI publish-path dry run cannot collide with a published version", () => {
	it("finds the job and its dry-run step (guards against a vacuous pass)", () => {
		const job = publishPathJob();
		expect(job).toContain(
			"name: Publish path (npm@latest, prepublishOnly, dry run)",
		);
		expect(stepOf(job, DRY_RUN), "no dry-run step").toBeDefined();
	});

	it("sets a per-run prerelease version before the dry run", () => {
		const job = publishPathJob();
		const step = stepOf(job, OVERRIDE);
		expect(step, `ci.yml publish-path has no "${OVERRIDE}" step`).toBeDefined();
		expect(step).toMatch(
			/npm pkg set "version=\$\{base\}-ci\.\$\{GITHUB_RUN_ID\}\.\$\{GITHUB_RUN_ATTEMPT\}"/,
		);
		expect(job.indexOf(OVERRIDE)).toBeLessThan(
			job.indexOf(`- name: ${DRY_RUN}`),
		);
	});

	it("hides the override from git so preflight's clean-tree check still runs", () => {
		// preflight-publish.mjs refuses a dirty tree. Hiding package.json from
		// `git status` keeps that check live instead of skipping preflight.
		expect(stepOf(publishPathJob(), OVERRIDE)).toContain(
			"git update-index --skip-worktree package.json",
		);
	});

	it("still runs the real lifecycle, with the tag npm requires for a prerelease", () => {
		const run = stepOf(publishPathJob(), DRY_RUN) ?? "";
		expect(run).toContain(
			"run: npm publish --dry-run --access public --tag ci-dry-run",
		);
		expect(run).not.toContain("--ignore-scripts");
		expect(pkg.scripts.prepublishOnly).toBe(
			"npm run preflight && npm run gate",
		);
	});

	it("never commits the throwaway version", () => {
		expect(committedVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
