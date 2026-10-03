// @vitest-environment node
//
// This spec reads the workflow files off disk, so `import.meta.url` must be a
// real file:// URL. The package default environment is jsdom — its subject is
// the browser boundary — and there that URL is http:, which node:url refuses.
//
// A workflow is executable code holding this repo's token. This file is the
// security gate on that surface.
//
// SUPPLY CHAIN — a `uses:` ref pinned to a moving tag (`@v5`) or a branch
// (`@main`) lets whoever controls that upstream ref run arbitrary code in this
// repo's CI. A full 40-hex commit SHA cannot be repointed, so the code we
// audited is the code that runs. Pinning is also TRANSITIVE: a pinned caller
// whose callee resolves a mutable ref at run time is not pinned at all, which
// is why first-party refs get no exemption here either.
//
// TOKEN SCOPE — a workflow with no top-level `permissions:` block inherits the
// repository default, which may be read-WRITE. Declaring a read-only scope at
// the top means a compromised step cannot push code or cut a release.
//
// This repo's ci.yml shipped with three unpinned actions (`actions/checkout@v5`,
// `pnpm/action-setup@v6`, `actions/setup-node@v5`) and nothing that could notice.
// Each rule below is paired with its own accept/reject cases so the rule itself
// is proven, not assumed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOWS = fileURLToPath(
	new URL("../.github/workflows", import.meta.url),
);

/** Matches `uses: <ref>` / `- uses: <ref>`, stopping before a trailing comment. */
const USES = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm;

/** owner/repo[/sub/path]@<40 lowercase hex> */
const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;

/** Local (`./`) actions ship in this commit, so they need no pin. */
const isImmutable = (ref: string): boolean =>
	ref.startsWith("./") || PINNED.test(ref);

/**
 * The value of the top-level `permissions:` key — any inline value plus every
 * following indented or comment line, stopping at the next column-0 key. Job
 * scopes live under `jobs:` and are deliberately NOT captured.
 */
const topLevelScope = (yaml: string): string | null =>
	/^permissions:(.*(?:\n[ \t#].*)*)/m.exec(yaml)?.[1] ?? null;

/** An explicit top-level scope that grants no write anywhere. */
const hasReadOnlyTopLevelScope = (yaml: string): boolean => {
	const scope = topLevelScope(yaml);
	return scope !== null && scope.trim() !== "" && !/\bwrite\b/.test(scope);
};

interface Workflow {
	readonly file: string;
	readonly yaml: string;
}

function readWorkflows(): readonly Workflow[] {
	return readdirSync(WORKFLOWS)
		.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
		.map((file) => ({
			file,
			yaml: readFileSync(join(WORKFLOWS, file), "utf8"),
		}));
}

function refsOf({ file, yaml }: Workflow): readonly string[] {
	return [...yaml.matchAll(USES)].flatMap((m) =>
		m[1] === undefined ? [] : [`${file}: ${m[1]}`],
	);
}

describe("GitHub Actions supply chain", () => {
	it("finds workflows and refs to scan (guards against a vacuous pass)", () => {
		expect(readWorkflows().length).toBeGreaterThan(0);
		expect(readWorkflows().flatMap(refsOf).length).toBeGreaterThan(0);
	});

	it("pins every external action to a full commit SHA", () => {
		const unpinned = readWorkflows()
			.flatMap(refsOf)
			.filter((entry) => !isImmutable(entry.split(": ")[1] ?? ""));
		expect(unpinned).toEqual([]);
	});
});

describe("GitHub Actions token scope", () => {
	it("gives every workflow an explicit read-only top-level scope", () => {
		const overscoped = readWorkflows()
			.filter(({ yaml }) => !hasReadOnlyTopLevelScope(yaml))
			.map(({ file }) => file);
		expect(overscoped).toEqual([]);
	});
});

// A secret is the one defect you cannot fix by reverting: once a credential is
// in the public history it is burned, and a revert only hides it from `HEAD`.
// So the scan has to run BEFORE the merge, on the pull request, not on a weekly
// sweep that finds it days later. This repo had no secret scan at all — it
// pinned ci's `ts-publish.yml` and nothing else, so no `gitleaks` check ever
// reported here and branch protection had nothing to require.
//
// This rule asserts the WIRING, which is the part that silently rots: a private
// or misconfigured reusable workflow makes caller runs VANISH rather than go
// red, so "the job is in the file" is the only thing a unit test can prove.
// That the scan actually CATCHES a secret is proven separately, by planting one
// and watching the check go red on a real PR.
describe("secret scanning", () => {
	const SECRET_SCAN = "hseshadr/ci/.github/workflows/secret-scan.yml";

	const secretScanRefs = (): readonly string[] =>
		readWorkflows()
			.flatMap(refsOf)
			.map((entry) => entry.split(": ")[1] ?? "")
			.filter((ref) => ref.startsWith(`${SECRET_SCAN}@`));

	it("calls ci's reusable secret-scan brick", () => {
		expect(secretScanRefs()).not.toEqual([]);
	});

	it("pins the secret-scan brick to a commit SHA, never a tag", () => {
		// `@ci-v3` would resolve at run time to whatever that tag points at today.
		// The scan holds this repo's token; a mutable ref here is a supply chain.
		const unpinned = secretScanRefs().filter((ref) => !isImmutable(ref));
		expect(unpinned).toEqual([]);
	});

	it("pins ci-v3.3.0, the last release that ships the brick", () => {
		// ci-v3.3.0 (8166345) keeps findings in the job log: no PR comment, no
		// summary, no SARIF artifact. ci-v3.2.1 still uploaded them. Later ci
		// commits delete the workflow, so newer is not available, only older.
		expect(secretScanRefs()).toEqual([
			`${SECRET_SCAN}@8166345c9355dde54c12fa95d0457c4ea97d3e64`,
		]);
	});

	it("asks the brick for full history, not just the event range", () => {
		// Without full-history the action scans only the commits a push or PR
		// introduced, and a push already on main scans zero commits and passes.
		const ci = readWorkflows().find(({ file }) => file === "ci.yml");
		expect(ci?.yaml).toMatch(
			/secret-scan\.yml@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+full-history: true\n/,
		);
	});

	it("runs the scan on pull requests, where a merge can still be stopped", () => {
		const ci = readWorkflows().find(({ file }) => file === "ci.yml");
		expect(ci?.yaml).toMatch(/^on:(?:.|\n)*?^\s+pull_request:/m);
	});
});

describe("the pin rule itself", () => {
	it.each([
		["a moving major tag", "actions/checkout@v5"],
		["the exact tag this repo shipped with", "pnpm/action-setup@v6"],
		["an exact version tag", "actions/setup-node@v6.4.0"],
		["a branch", "actions/checkout@main"],
		["a short SHA", "actions/checkout@9c091bb"],
		// 39 hex — one short of a real SHA.
		[
			"a truncated SHA",
			"actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e",
		],
		[
			"an uppercase SHA",
			"actions/checkout@9C091BB21B7C1C1D1991BB908D89E4E9DDDFE3E0",
		],
		["no ref at all", "actions/checkout"],
		// First-party is not the same as trustworthy: a nested mutable ref inside a
		// reusable workflow still resolves at run time, so it gets no exemption.
		[
			"a first-party ref on a moving tag",
			"hseshadr/ci/.github/workflows/frontend-gate.yml@ci-v2",
		],
	])("rejects %s", (_label, ref) => {
		expect(isImmutable(ref)).toBe(false);
	});

	it.each([
		[
			"a pinned action",
			"actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
		],
		[
			"a pinned reusable workflow with a subpath",
			"hseshadr/ci/.github/workflows/frontend-gate.yml@bc68fde66f0805971e1b9aa444933b7975da80b1",
		],
		["a local action", "./.github/actions/setup"],
	])("accepts %s", (_label, ref) => {
		expect(isImmutable(ref)).toBe(true);
	});

	it("flags an unpinned ref that appears alongside pinned ones", () => {
		const refs = [
			"actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
			"pnpm/action-setup@v6",
		];
		expect(refs.filter((r) => !isImmutable(r))).toEqual([
			"pnpm/action-setup@v6",
		]);
	});

	it("extracts refs from real workflow syntax, ignoring comments", () => {
		const yaml = [
			"      - uses: actions/checkout@abc # v7",
			"        uses: pnpm/action-setup@def",
			"      # uses: not/a-real@ref",
		].join("\n");
		expect([...yaml.matchAll(USES)].map((m) => m[1])).toEqual([
			"actions/checkout@abc",
			"pnpm/action-setup@def",
		]);
	});
});

describe("the token-scope rule itself", () => {
	it.each([
		["no permissions block at all", "name: CI\non:\n  push:\njobs:\n  a:\n"],
		["an empty permissions block", "permissions:\njobs:\n  a:\n"],
		["a blanket write-all", "permissions: write-all\njobs:\n  a:\n"],
		["a top-level write grant", "permissions:\n  contents: write\njobs:\n"],
		[
			"one write hidden among reads",
			"permissions:\n  contents: read\n  packages: write\njobs:\n",
		],
	])("rejects %s", (_label, yaml) => {
		expect(hasReadOnlyTopLevelScope(yaml)).toBe(false);
	});

	it.each([
		["a read-only scope", "permissions:\n  contents: read\njobs:\n  a:\n"],
		["an inline read-all", "permissions: read-all\njobs:\n  a:\n"],
		[
			"a job-level write under a read-only top level",
			"permissions:\n  contents: read\njobs:\n  publish:\n    permissions:\n      id-token: write\n",
		],
	])("accepts %s", (_label, yaml) => {
		expect(hasReadOnlyTopLevelScope(yaml)).toBe(true);
	});
});
