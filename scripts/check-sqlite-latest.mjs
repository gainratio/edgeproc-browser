#!/usr/bin/env node
// Weekly watchdog for the native pins in scripts/build-sqlite-vector-wasm.sh.
//
// The rule is "always build on the latest SQLite, the latest sqlite-vector and
// the latest emsdk". The build script pins all three exactly (URL + SHA3, a
// commit, an image digest), which is right for reproducibility and silent about
// staleness. This script closes that gap: it reads what upstream ships today,
// compares it with the pins, and if anything is behind it opens (or updates,
// never duplicates) one GitHub issue that says exactly what to pin.
//
// Fail closed: a network error, a non-2xx response, or a page whose format has
// changed is an ERROR (exit 1), never a quiet "up to date". A watchdog that
// goes green when it cannot see is worse than none.
//
// Usage:
//   node scripts/check-sqlite-latest.mjs            # report only
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
//     node scripts/check-sqlite-latest.mjs --issue  # also upsert the issue
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ISSUE_TITLE = "SQLite/sqlite-vector update available";

const SQLITE_ORIGIN = "https://www.sqlite.org/";
const SQLITE_DOWNLOAD_PAGE = `${SQLITE_ORIGIN}download.html`;
const VECTOR_REPO = "sqliteai/sqlite-vector";
const EMSDK_TAGS =
	"https://hub.docker.com/v2/repositories/emscripten/emsdk/tags?page_size=100&ordering=last_updated";
const GITHUB_API = "https://api.github.com";
const CSV_HEADER = "PRODUCT,VERSION,RELATIVE-URL,SIZE-IN-BYTES,SHA3-HASH";
const SRC_NAME = /^sqlite-src-(\d)(\d\d)(\d\d)(\d\d)\.zip$/;
const VERSION = /^v?(\d+(?:\.\d+){2,3})$/;
const SHA3 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** "sqlite-src-3530400.zip" -> "3.53.4"; a non-zero 4th field is kept. */
export function versionFromSrcName(name) {
	const m = SRC_NAME.exec(name);
	if (m === null) throw new Error(`not a sqlite-src archive name: ${name}`);
	const [, major, minor, patch, sub] = m.map(Number);
	const base = `${major}.${minor}.${patch}`;
	return sub === 0 ? base : `${base}.${sub}`;
}

function versionParts(v) {
	const m = VERSION.exec(v);
	if (m === null) throw new Error(`malformed version: ${JSON.stringify(v)}`);
	return m[1].split(".").map(Number);
}

/** Numeric dotted-version comparison: -1, 0 or 1. Missing fields count as 0. */
export function compareVersions(a, b) {
	const pa = versionParts(a);
	const pb = versionParts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

/** The sqlite-src row from the CSV block sqlite.org embeds for scripts. */
export function parseSqliteDownloadPage(html) {
	const lines = html.split(/\r?\n/).map((l) => l.trim());
	if (!lines.includes(CSV_HEADER)) {
		throw new Error(
			`sqlite.org download page format changed: no "${CSV_HEADER}" block`,
		);
	}
	const row = lines
		.filter((l) => l.startsWith("PRODUCT,") && l !== CSV_HEADER)
		.map((l) => l.split(","))
		.find((cols) => SRC_NAME.test(cols[2]?.split("/").pop() ?? ""));
	if (row === undefined || row.length !== 5) {
		throw new Error("sqlite.org download page lists no sqlite-src-*.zip row");
	}
	const [, version, relativeUrl, , sha3] = row;
	if (!SHA3.test(sha3)) throw new Error(`malformed SHA3 for ${relativeUrl}`);
	const fromName = versionFromSrcName(relativeUrl.split("/").pop());
	if (fromName !== version) {
		throw new Error(`VERSION ${version} disagrees with ${relativeUrl}`);
	}
	return { version, url: new URL(relativeUrl, SQLITE_ORIGIN).href, sha3 };
}

function shellVar(script, name, pattern) {
	const m = new RegExp(`^${name}=(\\S+)$`, "m").exec(script);
	if (m === null || !pattern.test(m[1])) {
		throw new Error(`build script has no valid ${name}`);
	}
	return m[1];
}

/** The pins in scripts/build-sqlite-vector-wasm.sh. */
export function parsePinned(script) {
	const sqliteUrl = shellVar(
		script,
		"SQLITE_URL",
		/^https:\/\/www\.sqlite\.org\/\d{4}\/sqlite-src-\d{7}\.zip$/,
	);
	const sqliteSha3 = shellVar(script, "SQLITE_SHA3", SHA3);
	const vectorCommit = shellVar(script, "VECTOR_COMMIT", COMMIT);
	const image = shellVar(script, "EMSDK_IMAGE", /^emscripten\/emsdk@sha256:/);
	const emsdkDigest = image.slice(image.indexOf("@") + 1);
	if (!DIGEST.test(emsdkDigest))
		throw new Error("malformed EMSDK_IMAGE digest");
	return {
		sqliteUrl,
		sqliteVersion: versionFromSrcName(sqliteUrl.split("/").pop()),
		sqliteSha3,
		vectorCommit,
		emsdkDigest,
	};
}

/** The newest plain x.y.z emsdk tag on a Docker Hub tags page. */
export function parseEmsdkTags(page, pinnedDigest) {
	if (!Array.isArray(page?.results)) {
		throw new Error("Docker Hub emsdk tags response has no results array");
	}
	const releases = page.results.filter((t) => /^\d+\.\d+\.\d+$/.test(t?.name));
	if (releases.length === 0) {
		throw new Error("Docker Hub lists no x.y.z emsdk release tags");
	}
	const latest = releases.reduce((a, b) =>
		compareVersions(a.name, b.name) >= 0 ? a : b,
	);
	if (!DIGEST.test(latest.digest ?? "")) {
		throw new Error(`emsdk tag ${latest.name} has no sha256 digest`);
	}
	const pinned = releases.find((t) => t.digest === pinnedDigest);
	return {
		tag: latest.name,
		digest: latest.digest,
		pinnedTag: pinned?.name ?? "unknown",
	};
}

function sqliteSection(pinned, sqlite) {
	if (compareVersions(pinned.sqliteVersion, sqlite.version) >= 0) return null;
	return [
		`### SQLite ${pinned.sqliteVersion} -> ${sqlite.version}`,
		"",
		`- \`SQLITE_URL=${sqlite.url}\``,
		`- \`SQLITE_SHA3=${sqlite.sha3}\``,
		"- Also update the `sqlite-src-NNNNNNN` directory name used later in the script.",
	].join("\n");
}

function vectorSection(pinned, vector) {
	if (vector.commit === pinned.vectorCommit) return null;
	return [
		`### sqlite-vector -> release ${vector.tag}`,
		"",
		`- \`VECTOR_COMMIT=${vector.commit}\` (pinned: \`${pinned.vectorCommit}\`)`,
	].join("\n");
}

function emsdkSection(pinned, emsdk) {
	if (emsdk.digest === pinned.emsdkDigest) return null;
	return [
		`### emsdk ${emsdk.pinnedTag} -> ${emsdk.tag}`,
		"",
		`- \`EMSDK_IMAGE=emscripten/emsdk@${emsdk.digest}\``,
	].join("\n");
}

/** Whether any pin is behind, and the issue body that says what to pin. */
export function assess(pinned, latest) {
	const sections = [
		sqliteSection(pinned, latest.sqlite),
		vectorSection(pinned, latest.vector),
		emsdkSection(pinned, latest.emsdk),
	].filter((s) => s !== null);
	const body = [
		"`scripts/build-sqlite-vector-wasm.sh` is behind upstream.",
		'Opened by `.github/workflows/sqlite-latest.yml`; the bump steps are in CONTRIBUTING.md ("Bumping SQLite, sqlite-vector or emsdk").',
		...sections,
	].join("\n\n");
	return { behind: sections.length > 0, body };
}

async function request(fetchImpl, url, init = {}) {
	const res = await fetchImpl(url, init);
	if (!res.ok)
		throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status}`);
	return res;
}

/** Open the update issue, or update the one already open. Never duplicates. */
export async function upsertIssue({ repo, token, body, fetchImpl = fetch }) {
	const headers = {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
	const base = `${GITHUB_API}/repos/${repo}/issues`;
	const list = await request(fetchImpl, `${base}?state=open&per_page=100`, {
		headers,
	});
	const open = (await list.json()).find((i) => i.title === ISSUE_TITLE);
	if (open === undefined) {
		const payload = JSON.stringify({ title: ISSUE_TITLE, body });
		await request(fetchImpl, base, { method: "POST", headers, body: payload });
		return;
	}
	const payload = JSON.stringify({ body });
	await request(fetchImpl, `${base}/${open.number}`, {
		method: "PATCH",
		headers,
		body: payload,
	});
}

async function latestVector(fetchImpl) {
	const headers = { accept: "application/vnd.github+json" };
	const api = `${GITHUB_API}/repos/${VECTOR_REPO}`;
	const rel = await (
		await request(fetchImpl, `${api}/releases/latest`, { headers })
	).json();
	versionParts(rel?.tag_name ?? "");
	const tag = encodeURIComponent(rel.tag_name);
	const commit = (
		await (
			await request(fetchImpl, `${api}/commits/${tag}`, { headers })
		).json()
	)?.sha;
	if (!COMMIT.test(commit ?? "")) {
		throw new Error(`sqlite-vector ${rel.tag_name} resolved to no commit`);
	}
	return { tag: rel.tag_name, commit };
}

async function main() {
	const script = readFileSync(
		fileURLToPath(new URL("./build-sqlite-vector-wasm.sh", import.meta.url)),
		"utf8",
	);
	const pinned = parsePinned(script);
	const page = await (await request(fetch, SQLITE_DOWNLOAD_PAGE)).text();
	const hub = await (await request(fetch, EMSDK_TAGS)).json();
	const result = assess(pinned, {
		sqlite: parseSqliteDownloadPage(page),
		vector: await latestVector(fetch),
		emsdk: parseEmsdkTags(hub, pinned.emsdkDigest),
	});
	console.log(result.behind ? result.body : "All pins are current.");
	if (!result.behind || !process.argv.includes("--issue")) return;
	const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repo } = process.env;
	if (!token || !repo)
		throw new Error("--issue needs GITHUB_TOKEN and GITHUB_REPOSITORY");
	await upsertIssue({ repo, token, body: result.body });
	console.log(`Upserted issue "${ISSUE_TITLE}" in ${repo}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(`check-sqlite-latest: ${error.message}`);
		process.exit(1);
	});
}
