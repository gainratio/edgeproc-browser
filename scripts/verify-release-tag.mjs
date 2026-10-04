#!/usr/bin/env node
// The release gate publish.yml runs BEFORE it may mint an npm credential.
//
// Pushing a `v*` tag used to be the whole trigger: 0.2.1 shipped from a commit
// whose CI on main was red (run 37225186415), because nothing asked. This
// refuses, failing closed, unless all three hold for the tagged commit:
//
//   1. The tag names package.json's version  (`v0.2.2` <-> "0.2.2").
//   2. The commit is on main                 (main contains it; a tag on a
//                                             side branch never reviewed is out).
//   3. CI concluded success on it            (the latest `ci.yml` push run for
//                                             exactly this SHA on main; still
//                                             running, failed, or missing all
//                                             refuse — rerun this job once CI
//                                             is green).
//
// Usage (publish.yml): GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA and
// GITHUB_REF_NAME come from the Actions runner. Exit 0 = publish may proceed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CI_WORKFLOW = "ci.yml";
export const RELEASE_BRANCH = "main";

/**
 * The pure verdict. `comparison` is GitHub's compare of main...sha (status
 * "identical" or "behind" means main already contains sha); `ciRuns` are the
 * workflow runs GitHub returned for this SHA. Returns the reasons to refuse.
 */
export function evaluateRelease({
	tag,
	packageVersion,
	sha,
	comparison,
	ciRuns,
}) {
	const failures = [];
	if (tag !== `v${packageVersion}`) {
		failures.push(
			`tag ${JSON.stringify(tag)} does not match package.json version ${JSON.stringify(packageVersion)} (expected "v${packageVersion}")`,
		);
	}
	const status = comparison?.status;
	if (status !== "identical" && status !== "behind") {
		failures.push(
			`commit ${sha} is not on ${RELEASE_BRANCH} (compare status: ${JSON.stringify(status)})`,
		);
	}
	const run = latestMainPushRun(ciRuns, sha);
	if (run === undefined) {
		failures.push(
			`no ${CI_WORKFLOW} push run on ${RELEASE_BRANCH} found for ${sha}`,
		);
	} else if (run.status !== "completed" || run.conclusion !== "success") {
		failures.push(
			`${CI_WORKFLOW} run ${run.html_url ?? run.id} for ${sha} is ${run.status}/${run.conclusion ?? "pending"}, not completed/success`,
		);
	}
	return failures;
}

/** The newest ci.yml run for exactly `sha`, pushed to main (reruns update it). */
function latestMainPushRun(ciRuns, sha) {
	const runs = (Array.isArray(ciRuns) ? ciRuns : []).filter(
		(run) =>
			run.head_sha === sha &&
			run.event === "push" &&
			run.head_branch === RELEASE_BRANCH,
	);
	runs.sort((a, b) => b.run_number - a.run_number);
	return runs[0];
}

/** Fetch what evaluateRelease needs. `api(path)` returns parsed JSON or throws. */
export async function verifyRelease({ repo, sha, tag, packageVersion, api }) {
	const [comparison, runs] = await Promise.all([
		api(`/repos/${repo}/compare/${RELEASE_BRANCH}...${sha}`),
		api(
			`/repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=push&branch=${RELEASE_BRANCH}&per_page=100`,
		),
	]);
	return evaluateRelease({
		tag,
		packageVersion,
		sha,
		comparison,
		ciRuns: runs?.workflow_runs,
	});
}

/** A GitHub REST reader. Any non-2xx is an error: an unreadable answer refuses. */
export function githubApi(token, fetchImpl = fetch) {
	return async (path) => {
		const response = await fetchImpl(`https://api.github.com${path}`, {
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${token}`,
				"x-github-api-version": "2022-11-28",
			},
		});
		if (!response.ok) {
			throw new Error(`GitHub API ${path} answered ${response.status}`);
		}
		return response.json();
	};
}

/** Read the runner's environment; a missing value refuses rather than guesses. */
export function releaseContext(env, root) {
	const missing = [
		"GITHUB_TOKEN",
		"GITHUB_REPOSITORY",
		"GITHUB_SHA",
		"GITHUB_REF_NAME",
	].filter((name) => !env[name]);
	if (missing.length > 0) {
		throw new Error(`missing environment: ${missing.join(", ")}`);
	}
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	return {
		token: env.GITHUB_TOKEN,
		repo: env.GITHUB_REPOSITORY,
		sha: env.GITHUB_SHA,
		tag: env.GITHUB_REF_NAME,
		packageVersion: pkg.version,
	};
}

export async function main(
	env = process.env,
	root = process.cwd(),
	fetchImpl = fetch,
) {
	let failures;
	try {
		const context = releaseContext(env, root);
		failures = await verifyRelease({
			...context,
			api: githubApi(context.token, fetchImpl),
		});
	} catch (error) {
		failures = [error instanceof Error ? error.message : String(error)];
	}
	for (const failure of failures) console.error(`release refused: ${failure}`);
	if (failures.length === 0)
		console.log("release gate: tag, main and CI all check out");
	return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}
