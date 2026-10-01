// @vitest-environment node
//
// The publish preflight is the only thing standing between `npm publish` and a
// tarball that matches no fetchable commit. A guard nobody has watched refuse is
// not a guard, so every refusal below is driven for real: a throwaway git repo is
// built on disk in each shape the script must reject, the script is executed
// against it, and the exit code is the verdict — never grepped prose alone.
//
// The accept case matters just as much. A guard that refuses everything also
// "passes" a reject-only suite, and would quietly make releases impossible.
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const PREFLIGHT = fileURLToPath(
	new URL("../scripts/preflight-publish.mjs", import.meta.url),
);

const scratch: string[] = [];

afterEach(() => {
	while (scratch.length > 0) {
		const dir = scratch.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "edgeproc-preflight-"));
	scratch.push(dir);
	return dir;
}

function git(dir: string, ...args: readonly string[]): void {
	execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function gitOutput(dir: string, ...args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/**
 * A minimal repo with disposable build output, one commit, and a clean tree. The
 * local identity and unsigned commits are forced so a contributor's global git
 * config cannot decide whether this suite passes.
 */
function repoWithOneCommit(): string {
	const dir = scratchDir();
	git(dir, "init", "-q", "-b", "main");
	git(dir, "config", "user.email", "preflight@example.invalid");
	git(dir, "config", "user.name", "Preflight Test");
	git(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, ".gitignore"), "dist\n");
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "init");
	return dir;
}

/** Marks HEAD as present on a remote, without needing one to exist. */
function markPushed(dir: string): void {
	git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
}

function bareRemote(): string {
	const dir = scratchDir();
	git(dir, "init", "-q", "--bare");
	return dir;
}

function shallowTagCheckout(kind: "lightweight" | "annotated"): string {
	const source = repoWithOneCommit();
	const remote = bareRemote();
	git(source, "remote", "add", "origin", remote);
	if (kind === "annotated") {
		git(source, "tag", "-a", "v0.1.0", "-m", "release v0.1.0");
	} else {
		git(source, "tag", "v0.1.0");
	}
	git(source, "push", "-q", "origin", "refs/tags/v0.1.0");

	const checkout = scratchDir();
	git(checkout, "init", "-q");
	git(checkout, "remote", "add", "origin", remote);
	git(
		checkout,
		"fetch",
		"-q",
		"--depth=1",
		"origin",
		"refs/tags/v0.1.0:refs/tags/v0.1.0",
	);
	git(checkout, "checkout", "-q", "--detach", "refs/tags/v0.1.0");
	expect(gitOutput(checkout, "branch", "--remotes")).toBe("");
	return checkout;
}

/** A dist/ that a real stale-build publish would have shipped verbatim. */
function staleDist(dir: string): string {
	const dist = join(dir, "dist");
	mkdirSync(dist, { recursive: true });
	const stale = join(dist, "stale.js");
	writeFileSync(stale, "export const built = 'from some other commit';\n");
	return stale;
}

function runPreflight(dir: string): { status: number | null; output: string } {
	const r = spawnSync(process.execPath, [PREFLIGHT], {
		cwd: dir,
		encoding: "utf8",
	});
	return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("publish preflight", () => {
	it("refuses when there is no git work tree to name a commit", () => {
		const { status, output } = runPreflight(scratchDir());
		expect(status).toBe(1);
		expect(output).toMatch(/not a git work tree/);
	});

	it("refuses a dirty tree, and does not touch dist on the way out", () => {
		const dir = repoWithOneCommit();
		markPushed(dir);
		const stale = staleDist(dir);
		writeFileSync(join(dir, "uncommitted.ts"), "export const x = 1;\n");

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/working tree is not clean/);
		expect(output).toContain("uncommitted.ts");
		// Refuse BEFORE mutating: a guard that half-runs is a guard that has to be
		// re-run by hand to get back to a known state.
		expect(existsSync(stale)).toBe(true);
	});

	it("refuses a commit that exists only on this machine", () => {
		const dir = repoWithOneCommit();

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/on no remote-tracking branch/);
	});

	it("refuses a local-only tag that origin cannot reproduce", () => {
		const dir = repoWithOneCommit();
		git(dir, "remote", "add", "origin", bareRemote());
		git(dir, "tag", "v0.1.0");
		const stale = staleDist(dir);

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/no exact local tag published unchanged to origin/);
		expect(existsSync(stale)).toBe(true);
	});

	it("fails closed when origin cannot be queried", () => {
		const dir = repoWithOneCommit();
		git(dir, "remote", "add", "origin", join(dir, "missing-origin.git"));
		git(dir, "tag", "v0.1.0");
		const stale = staleDist(dir);

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/no exact local tag published unchanged to origin/);
		expect(existsSync(stale)).toBe(true);
	});

	it("refuses a same-name origin tag that identifies another commit", () => {
		const remoteSource = repoWithOneCommit();
		writeFileSync(join(remoteSource, "remote-only"), "different commit\n");
		git(remoteSource, "add", ".");
		git(remoteSource, "commit", "-q", "-m", "remote release");
		git(remoteSource, "tag", "v0.1.0");
		const remote = bareRemote();
		git(remoteSource, "remote", "add", "origin", remote);
		git(remoteSource, "push", "-q", "origin", "refs/tags/v0.1.0");

		const dir = repoWithOneCommit();
		git(dir, "remote", "add", "origin", remote);
		git(dir, "tag", "v0.1.0");

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/no exact local tag published unchanged to origin/);
	});

	it("refuses a rewritten annotated tag even when its commit is unchanged", () => {
		const dir = repoWithOneCommit();
		const remote = bareRemote();
		git(dir, "remote", "add", "origin", remote);
		git(dir, "tag", "-a", "v0.1.0", "-m", "published annotation");
		git(dir, "push", "-q", "origin", "refs/tags/v0.1.0");
		git(
			dir,
			"tag",
			"-f",
			"-a",
			"v0.1.0",
			"-m",
			"local rewrite of the same commit",
		);

		const { status, output } = runPreflight(dir);

		expect(status).toBe(1);
		expect(output).toMatch(/no exact local tag published unchanged to origin/);
	});

	it.each(["lightweight", "annotated"] as const)(
		"accepts an Actions-like shallow checkout of a published %s tag",
		(kind) => {
			const dir = shallowTagCheckout(kind);
			const stale = staleDist(dir);

			const { status, output } = runPreflight(dir);

			expect(status).toBe(0);
			expect(output).toMatch(/preflight OK/);
			expect(existsSync(stale)).toBe(false);
		},
	);

	it("accepts a clean pushed commit, and empties dist so the build is from scratch", () => {
		const dir = repoWithOneCommit();
		markPushed(dir);
		const stale = staleDist(dir);

		const { status, output } = runPreflight(dir);

		expect(status).toBe(0);
		expect(output).toMatch(/preflight OK/);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(join(dir, "dist"))).toBe(false);
	});
});

// `preflight` DELETES dist/, and the `gate` that follows runs typecheck BEFORE
// build. So any public entry point that resolves only through `exports` ->
// dist/ makes `npm publish` structurally impossible: typecheck dies on TS2307
// against a path the build will not produce until two steps later. CI never
// sees it, because `prepare` builds on install and nothing deletes dist there.
// That is exactly why 0.1.0 had never been published. The typecheck tsconfig
// must therefore resolve every public entry from SOURCE.
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const TSCONFIG = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every public subpath in `exports`, as the specifier a consumer would write. */
function publicSpecifiers(): readonly string[] {
	const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
	return Object.keys(pkg.exports)
		.filter((key) => key !== "./package.json")
		.map((key) => (key === "." ? pkg.name : `${pkg.name}${key.slice(1)}`));
}

/** Strip JSONC comments that sit outside string literals, then trailing commas. */
function stripJsonComments(text: string): string {
	let out = "";
	let inString = false;
	let inLine = false;
	let inBlock = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i] ?? "";
		const next = text[i + 1] ?? "";

		if (inLine) {
			if (ch === "\n") {
				inLine = false;
				out += ch;
			}
		} else if (inBlock) {
			if (ch === "*" && next === "/") {
				inBlock = false;
				i += 1;
			}
		} else if (inString) {
			out += ch;
			if (ch === "\\") {
				out += next;
				i += 1;
			} else if (ch === '"') {
				inString = false;
			}
		} else if (ch === '"') {
			inString = true;
			out += ch;
		} else if (ch === "/" && next === "/") {
			inLine = true;
			i += 1;
		} else if (ch === "/" && next === "*") {
			inBlock = true;
			i += 1;
		} else {
			out += ch;
		}
	}

	return out.replace(/,(\s*[}\]])/g, "$1");
}

/** `compilerOptions.paths` from the JSONC typecheck config. */
function typecheckPaths(): Record<string, string[]> {
	const raw = stripJsonComments(readFileSync(TSCONFIG, "utf8"));
	return JSON.parse(raw).compilerOptions?.paths ?? {};
}

describe("the publish gate survives the dist that preflight deletes", () => {
	it("finds public entry points to check (guards against a vacuous pass)", () => {
		expect(publicSpecifiers().length).toBeGreaterThan(1);
		expect(publicSpecifiers()).toContain("@gainratio/browser");
	});

	it("resolves every public entry point from source, not from dist", () => {
		const paths = typecheckPaths();

		const unmapped = publicSpecifiers().filter(
			(specifier) => paths[specifier] === undefined,
		);

		expect(unmapped).toEqual([]);
	});

	it("points every mapping at a source file that exists", () => {
		const paths = typecheckPaths();

		const broken = Object.entries(paths).flatMap(([specifier, targets]) =>
			targets
				.filter((target) => !existsSync(join(SOURCE_ROOT, target)))
				.map((target) => `${specifier} -> ${target}`),
		);

		expect(broken).toEqual([]);
	});

	it("never points a mapping into dist, which publishing removes", () => {
		const intoDist = Object.entries(typecheckPaths()).flatMap(
			([specifier, targets]) =>
				targets
					.filter((target) => target.replace("./", "").startsWith("dist/"))
					.map((target) => `${specifier} -> ${target}`),
		);

		expect(intoDist).toEqual([]);
	});
});
