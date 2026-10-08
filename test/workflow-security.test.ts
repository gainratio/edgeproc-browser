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
// CONTRACT CHANGE (2026-10-08): this block used to require ci's reusable
// secret-scan brick pinned at ci-v3.3.0. ci retired that catalog (7c75ff1), and
// after the move to the gainratio ORG gitleaks-action refuses to run without a
// license. The scan is now an inline job: a faithful copy of the ci-v3.3.0
// brick's job, plus the org's GITLEAKS_LICENSE secret on the action step.
//
// These rules assert the WIRING. That the scan actually CATCHES a secret is
// proven separately, by planting one and watching the check go red on a PR.
/**
 * The central ci repository's owner. ci moved hseshadr -> gainratio, and GitHub
 * does NOT redirect `uses:` for a moved repository: an `hseshadr/ci/...` ref no
 * longer resolves and the caller job fails before it starts.
 */
const CENTRAL_CI_OWNER = "gainratio";
const GITLEAKS_ACTION_COMMIT = "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e";
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal GitHub Actions expression, not a template.
const LICENSE_ENV = "GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}";

/** Every `uses:` ref, across all workflows, that names a ci repository. */
const ciRefs = (): readonly string[] =>
	readWorkflows()
		.flatMap(refsOf)
		.map((entry) => entry.split(": ")[1] ?? "")
		.filter((ref) => /^[^/]+\/ci\//.test(ref));

/** The lines of the step that starts at `- uses: <prefix>`, or "" if absent. */
function stepOf(yaml: string, prefix: string): string {
	const lines = yaml.split("\n");
	const start = lines.findIndex((line) =>
		line.trimStart().startsWith(`- uses: ${prefix}`),
	);
	if (start === -1) return "";
	const indent = (lines[start] ?? "").indexOf("-");
	const rest = lines.slice(start + 1);
	const end = rest.findIndex(
		(line) => line.trim() !== "" && line.search(/\S/) <= indent,
	);
	return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

describe("secret scanning", () => {
	const ciYaml = (): string =>
		readWorkflows().find(({ file }) => file === "ci.yml")?.yaml ?? "";
	const gitleaksStep = (): string =>
		stepOf(ciYaml(), "gitleaks/gitleaks-action@");

	it("finds the step it checks (guards against a vacuous pass)", () => {
		expect(
			stepOf("  - uses: a/b@c\n    env:\n      X: 1\n  - run: y", "a/b@"),
		).toBe("  - uses: a/b@c\n    env:\n      X: 1");
		expect(stepOf("  - run: y", "a/b@")).toBe("");
	});

	it("calls every ci brick from gainratio/ci, never the pre-move owner", () => {
		const refs = ciRefs();
		expect(refs).not.toEqual([]);
		expect(
			refs.filter((ref) => !ref.startsWith(`${CENTRAL_CI_OWNER}/ci/`)),
		).toEqual([]);
	});

	it("reports under the exact check name branch protection requires", () => {
		expect(ciYaml()).toMatch(
			/^ {2}gitleaks:\n {4}name: Secret scan \/ gitleaks$/m,
		);
	});

	it("no longer calls ci's retired reusable secret-scan brick", () => {
		expect(ciYaml()).not.toContain("secret-scan.yml@");
	});

	it("runs gitleaks-action pinned to the ci-v3.3.0 brick's commit SHA", () => {
		expect(gitleaksStep()).toContain(
			`- uses: gitleaks/gitleaks-action@${GITLEAKS_ACTION_COMMIT} # v3.0.0`,
		);
	});

	it("hands the action the org license from secrets, never a literal", () => {
		// gainratio is an organization: without this the action exits before
		// scanning with "missing gitleaks license".
		expect(gitleaksStep()).toContain(LICENSE_ENV);
	});

	it("keeps findings in the redacted job log only", () => {
		const step = gitleaksStep();
		for (const flag of ["COMMENTS", "SUMMARY", "UPLOAD_ARTIFACT"]) {
			expect(step).toContain(`GITLEAKS_ENABLE_${flag}: "false"`);
		}
	});

	it("checks out every commit and sweeps full history, not just the event range", () => {
		// The action alone scans only the commits a push or PR introduced; a push
		// already on main scans zero commits and passes.
		const ci = ciYaml();
		expect(stepOf(ci, "actions/checkout@")).toMatch(/^\s+fetch-depth: 0$/m);
		expect(ci).toContain(
			'gitleaks git --redact --no-banner --log-opts="--all" .',
		);
	});

	it("grants the job only contents and pull-requests read", () => {
		expect(ciYaml()).toMatch(
			/name: Secret scan \/ gitleaks\n(?:\s*#.*\n)*\s+permissions:\n\s+contents: read\n\s+pull-requests: read\n/,
		);
	});

	it("runs the scan on pull requests, where a merge can still be stopped", () => {
		expect(ciYaml()).toMatch(/^on:(?:.|\n)*?^\s+pull_request:/m);
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

// ci-v3.3.0 is the last ci release that ships the reusable bricks; ci's default
// branch deleted them. Dependabot must never bump these pins, under either owner,
// or the bump lands on a commit without the files and every run vanishes.
describe("dependabot keeps the central ci pins frozen", () => {
	const DEPENDABOT = fileURLToPath(
		new URL("../.github/dependabot.yml", import.meta.url),
	);

	const ignored = (): readonly string[] =>
		[
			...readFileSync(DEPENDABOT, "utf8").matchAll(
				/^\s*-\s*dependency-name:\s*"([^"]+)"/gm,
			),
		].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

	it("ignores the central ci repository under both owners", () => {
		expect(ignored()).toEqual(
			expect.arrayContaining(["hseshadr/ci*", "gainratio/ci*"]),
		);
	});
});
