#!/usr/bin/env node
// The guard that stands between `npm publish` and unauditable bytes.
//
// `files: ["dist"]` means the tarball IS dist/. The repository now commits a
// deterministic copy for exact-Git clients, but publishing must still rebuild
// from clean source rather than trust whatever happens to be on disk. That is not a
// hypothetical: on 2026-08-08 dist/engine/client.js was rebuilt at 05:58:53,
// three minutes AFTER f3607eb added `#releaseWorker()` and two days after the
// only commit on main. The compiled output carried a fix `main` did not have.
// The publish was stopped by a missing OTP, not by anything in this repo.
//
// So this refuses, before the build runs, on the three ways dist/ can end up
// describing something other than a fetchable commit:
//
//   1. Not a git work tree      — there is no commit to be the source of truth.
//   2. Dirty tree               — source or committed output differs from HEAD.
//   3. HEAD not proven remote   — the commit is neither on a remote-tracking
//                                 branch nor the exact target of a tag on origin.
//
// Then it DELETES dist/, so the `pnpm gate` that follows cannot reuse a stale
// object. tsc's outDir is additive: it overwrites what it re-emits and leaves
// behind whatever it doesn't, so a file deleted from src/ lingers in dist/
// forever unless something removes it. Clean tree + empty dist + a build from
// those sources is what makes "the tarball is a clean build of HEAD" true
// rather than hoped for.
//
// Residual gap, stated rather than papered over: this proves the SOURCES are
// HEAD's, not that the toolchain is. A locally mutated node_modules would still
// change the output. CI's `--frozen-lockfile` install is what closes that, and
// publish.yml re-runs the whole gate from the tagged ref for exactly this reason.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

// npm runs lifecycle scripts with cwd set to the package root.
const ROOT = process.cwd();

/** Trimmed stdout of a git invocation. Throws if git exits non-zero. */
function git(...args) {
	return execFileSync("git", args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** Same, but a git failure reads as "no answer" rather than a crash. */
function gitOrNull(...args) {
	try {
		return git(...args);
	} catch {
		return null;
	}
}

/** A bounded, non-interactive remote query. Any failure means "not proven". */
function gitRemoteOrNull(...args) {
	try {
		return execFileSync("git", args, {
			cwd: ROOT,
			encoding: "utf8",
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 15_000,
		}).trim();
	} catch {
		return null;
	}
}

function lines(output) {
	return output === "" ? [] : output.split("\n");
}

function remoteRefs(output) {
	const refs = new Map();
	for (const line of lines(output)) {
		const [object, ref, extra] = line.split("\t");
		if (
			extra !== undefined ||
			object === undefined ||
			!/^[0-9a-f]{40,64}$/.test(object) ||
			ref === undefined ||
			refs.has(ref)
		) {
			return null;
		}
		refs.set(ref, object);
	}
	return refs;
}

function exactTagIsPublished(head) {
	const tagOutput = gitOrNull("tag", "--points-at", head);
	if (tagOutput === null) return false;
	const tags = lines(tagOutput);
	if (tags.length === 0) return false;
	const patterns = tags.flatMap((tag) => [
		`refs/tags/${tag}`,
		`refs/tags/${tag}^{}`,
	]);
	const advertised = gitRemoteOrNull(
		"ls-remote",
		"--exit-code",
		"--tags",
		"origin",
		...patterns,
	);
	if (advertised === null) return false;
	const refs = remoteRefs(advertised);
	if (refs === null) return false;
	for (const tag of tags) {
		const ref = `refs/tags/${tag}`;
		const localObject = gitOrNull("rev-parse", "--verify", ref);
		const localCommit = gitOrNull("rev-parse", "--verify", `${ref}^{commit}`);
		if (localObject === null || localCommit !== head) return false;
		if (refs.get(ref) !== localObject) continue;
		if (localObject === head || refs.get(`${ref}^{}`) === head) return true;
	}
	return false;
}

/** Every refusal exits 1 and says what to do about it. npm aborts the publish. */
function refuse(reason, fix) {
	process.stderr.write(`\nREFUSING TO PUBLISH: ${reason}\n\n  ${fix}\n\n`);
	process.exit(1);
}

if (gitOrNull("rev-parse", "--is-inside-work-tree") !== "true") {
	refuse(
		`${ROOT} is not a git work tree, so there is no commit the tarball could correspond to.`,
		"Publish from a clone of gainratio/edgeproc-browser, never from an unpacked directory.",
	);
}

const dirty = gitOrNull("status", "--porcelain");
if (dirty === null || dirty !== "") {
	refuse(
		`the working tree is not clean, so the build's inputs are not any commit's contents:\n${dirty ?? "(git status failed)"}`,
		"Commit or stash the changes, push them, then publish.",
	);
}

const head = gitOrNull("rev-parse", "HEAD");
if (head === null) {
	refuse(
		"HEAD does not resolve to a commit.",
		"Publish from a checked-out commit, not an unborn branch.",
	);
}

const remoteBranches = gitOrNull("branch", "--remotes", "--contains", head);
if (
	remoteBranches === null ||
	(remoteBranches === "" && !exactTagIsPublished(head))
) {
	refuse(
		`HEAD (${head}) is on no remote-tracking branch and has no exact local tag published unchanged to origin, so nobody can reproduce this tarball.`,
		"Push the commit or its exact release tag (and `git fetch` if it was pushed elsewhere), then publish.",
	);
}

// Additive outDir + stale objects = a tarball nobody built. Start from nothing.
rmSync(join(ROOT, "dist"), { recursive: true, force: true });
process.stdout.write(
	`publish preflight OK — clean tree at ${head}, dist/ removed; the gate rebuilds it from these sources.\n`,
);
