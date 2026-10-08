// @vitest-environment node
//
// scripts/check-sqlite-latest.mjs is the weekly watchdog for the two native
// pins in scripts/build-sqlite-vector-wasm.sh. These tests cover its parsing,
// its comparison and its issue upsert with no network: every upstream response
// is a fixture, and the GitHub API is a recording fake.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assess,
	compareVersions,
	ISSUE_TITLE,
	parseBackports,
	parseEmsdkTags,
	parsePinned,
	parseSqliteDownloadPage,
	upsertIssue,
	versionFromSrcName,
} from "../scripts/check-sqlite-latest.mjs";

const BUILD_SCRIPT = readFileSync(
	fileURLToPath(
		new URL("../scripts/build-sqlite-vector-wasm.sh", import.meta.url),
	),
	"utf8",
);

const SHA3_A = "a".repeat(64);
const COMMIT_PINNED = "0c2223ada9dce1fa33248c8835a15f51d9a0f655";
const COMMIT_NEW = "1".repeat(40);

/** The shape sqlite.org ships: a CSV block inside an HTML comment. */
function downloadPage(rows: readonly string[]): string {
	return [
		"<html><body>",
		"<!-- Download product data for scripts to read",
		"PRODUCT,VERSION,RELATIVE-URL,SIZE-IN-BYTES,SHA3-HASH",
		...rows,
		"-->",
		"</body></html>",
	].join("\n");
}

const SRC_ROW = (code: string, version: string, sha3 = SHA3_A): string =>
	`PRODUCT,${version},2026/sqlite-src-${code}.zip,14557315,${sha3}`;

const DIGEST_PINNED = `sha256:${"d".repeat(64)}`;
const DIGEST_NEW = `sha256:${"e".repeat(64)}`;

const PINNED = {
	sqliteUrl: "https://www.sqlite.org/2026/sqlite-src-3530400.zip",
	sqliteVersion: "3.53.4",
	sqliteSha3: SHA3_A,
	vectorCommit: COMMIT_PINNED,
	emsdkDigest: DIGEST_PINNED,
};

const EMSDK_CURRENT = {
	tag: "6.0.11",
	digest: DIGEST_PINNED,
	pinnedTag: "6.0.11",
};

describe("versionFromSrcName", () => {
	it.each([
		["sqlite-src-3530400.zip", "3.53.4"],
		["sqlite-src-3540000.zip", "3.54.0"],
		["sqlite-src-3530401.zip", "3.53.4.1"],
		["sqlite-src-4000000.zip", "4.0.0"],
	])("decodes %s as %s", (name, version) => {
		expect(versionFromSrcName(name)).toBe(version);
	});

	it("refuses a name that is not a source archive", () => {
		expect(() => versionFromSrcName("sqlite-amalgamation-3530400.zip")).toThrow(
			/sqlite-src/,
		);
	});
});

describe("compareVersions", () => {
	it.each([
		["3.53.4", "3.54.0", -1, "behind"],
		["3.53.4", "3.53.4", 0, "equal"],
		["3.54.0", "3.53.4", 1, "ahead"],
		["3.53.4", "3.53.4.1", -1, "behind by a patch-of-patch"],
		["3.9.0", "3.10.0", -1, "numeric, not lexical"],
		["1.1.2", "v1.1.3", -1, "tolerates a v prefix"],
	])("compares %s with %s as %i (%s)", (a, b, expected) => {
		expect(compareVersions(a, b)).toBe(expected);
	});

	it.each(["", "3.53", "3.x.4", "latest"])("refuses malformed %j", (bad) => {
		expect(() => compareVersions(bad, "3.53.4")).toThrow(/version/i);
	});
});

describe("parseSqliteDownloadPage", () => {
	it("reads the source archive row from the CSV comment block", () => {
		const page = downloadPage([
			"PRODUCT,2026-07-31 22:45 UTC,snapshot/sqlite-snapshot-202607312245.tar.gz,3312178,ffff",
			SRC_ROW("3540000", "3.54.0"),
			`PRODUCT,3.54.0,2026/sqlite-amalgamation-3540000.zip,2946650,${"b".repeat(64)}`,
		]);
		expect(parseSqliteDownloadPage(page)).toEqual({
			version: "3.54.0",
			url: "https://www.sqlite.org/2026/sqlite-src-3540000.zip",
			sha3: SHA3_A,
		});
	});

	it("fails closed when the CSV header is gone", () => {
		expect(() => parseSqliteDownloadPage("<html>maintenance</html>")).toThrow(
			/format changed/,
		);
	});

	it("fails closed when no sqlite-src row is listed", () => {
		const page = downloadPage([
			`PRODUCT,3.54.0,2026/sqlite-amalgamation-3540000.zip,1,${SHA3_A}`,
		]);
		expect(() => parseSqliteDownloadPage(page)).toThrow(/sqlite-src/);
	});

	it("fails closed when the SHA3 column is not a SHA3-256 digest", () => {
		const page = downloadPage([SRC_ROW("3540000", "3.54.0", "not-a-hash")]);
		expect(() => parseSqliteDownloadPage(page)).toThrow(/SHA3/);
	});

	it("fails closed when the VERSION column disagrees with the file name", () => {
		const page = downloadPage([SRC_ROW("3540000", "3.53.9")]);
		expect(() => parseSqliteDownloadPage(page)).toThrow(/disagrees/);
	});
});

describe("parsePinned", () => {
	it("reads the real build script's pins", () => {
		const pinned = parsePinned(BUILD_SCRIPT);
		expect(pinned.sqliteUrl).toMatch(
			/^https:\/\/www\.sqlite\.org\/\d{4}\/sqlite-src-\d{7}\.zip$/,
		);
		expect(pinned.sqliteVersion).toMatch(/^\d+\.\d+\.\d+/);
		expect(pinned.sqliteSha3).toMatch(/^[0-9a-f]{64}$/);
		expect(pinned.vectorCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(pinned.emsdkDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
	});

	it("fails closed when EMSDK_IMAGE is a tag, not a digest", () => {
		const script = BUILD_SCRIPT.replace(
			/^EMSDK_IMAGE=.*$/m,
			"EMSDK_IMAGE=emscripten/emsdk:latest",
		);
		expect(() => parsePinned(script)).toThrow(/EMSDK_IMAGE/);
	});

	it("fails closed when a pin is missing", () => {
		expect(() =>
			parsePinned(
				"SQLITE_URL=https://www.sqlite.org/2026/sqlite-src-3530400.zip",
			),
		).toThrow(/SQLITE_SHA3/);
	});
});

describe("parseEmsdkTags", () => {
	const tag = (name: string, digest: string) => ({ name, digest });

	it("picks the highest plain x.y.z tag, numerically, and names the pinned digest", () => {
		const page = {
			results: [
				tag("latest", DIGEST_NEW),
				tag("6.0.11-arm64", `sha256:${"f".repeat(64)}`),
				tag("6.0.9", DIGEST_PINNED),
				tag("6.0.11", DIGEST_NEW),
				tag("6.0.10", `sha256:${"0".repeat(64)}`),
			],
		};
		expect(parseEmsdkTags(page, DIGEST_PINNED)).toEqual({
			tag: "6.0.11",
			digest: DIGEST_NEW,
			pinnedTag: "6.0.9",
		});
	});

	it("reports an unlisted pinned digest as unknown rather than guessing", () => {
		const page = { results: [tag("6.0.11", DIGEST_NEW)] };
		expect(parseEmsdkTags(page, DIGEST_PINNED).pinnedTag).toBe("unknown");
	});

	it.each([
		["no results array", { detail: "rate limited" }],
		["no release tags", { results: [tag("latest", DIGEST_NEW)] }],
		["a release tag without a digest", { results: [{ name: "6.0.11" }] }],
	])("fails closed on %s", (_label, page) => {
		expect(() => parseEmsdkTags(page, DIGEST_PINNED)).toThrow(/emsdk/);
	});
});

describe("assess", () => {
	const latestVector = { tag: "1.1.2", commit: COMMIT_PINNED };

	it("is current when both pins equal upstream", () => {
		const result = assess(PINNED, {
			sqlite: { version: "3.53.4", url: PINNED.sqliteUrl, sha3: SHA3_A },
			vector: latestVector,
			emsdk: EMSDK_CURRENT,
		});
		expect(result.behind).toBe(false);
	});

	it("is current when the pin is AHEAD of the download page", () => {
		const result = assess(PINNED, {
			sqlite: { version: "3.53.3", url: "u", sha3: SHA3_A },
			vector: latestVector,
			emsdk: EMSDK_CURRENT,
		});
		expect(result.behind).toBe(false);
	});

	it("is behind on a newer SQLite, and the body names the new URL and SHA3", () => {
		const sha3 = "c".repeat(64);
		const url = "https://www.sqlite.org/2026/sqlite-src-3540000.zip";
		const result = assess(PINNED, {
			sqlite: { version: "3.54.0", url, sha3 },
			vector: latestVector,
			emsdk: EMSDK_CURRENT,
		});
		expect(result.behind).toBe(true);
		expect(result.body).toContain("3.53.4");
		expect(result.body).toContain("3.54.0");
		expect(result.body).toContain(url);
		expect(result.body).toContain(sha3);
	});

	it("is behind when the latest sqlite-vector release is another commit", () => {
		const result = assess(PINNED, {
			sqlite: { version: "3.53.4", url: PINNED.sqliteUrl, sha3: SHA3_A },
			vector: { tag: "1.2.0", commit: COMMIT_NEW },
			emsdk: EMSDK_CURRENT,
		});
		expect(result.behind).toBe(true);
		expect(result.body).toContain("1.2.0");
		expect(result.body).toContain(COMMIT_NEW);
	});
});

it("assess is behind when the latest emsdk release has another digest", () => {
	const result = assess(PINNED, {
		sqlite: { version: "3.53.4", url: PINNED.sqliteUrl, sha3: SHA3_A },
		vector: { tag: "1.1.2", commit: COMMIT_PINNED },
		emsdk: { tag: "6.0.12", digest: DIGEST_NEW, pinnedTag: "6.0.11" },
	});
	expect(result.behind).toBe(true);
	expect(result.body).toContain("6.0.12");
	expect(result.body).toContain(`emscripten/emsdk@${DIGEST_NEW}`);
});

const PATCHES_DIR = new URL("../scripts/sqlite-wasm-patches/", import.meta.url);
const BACKPORT_PATCH = "0002-sahpool-check-reserved-lock.patch";
const BACKPORT = { patch: BACKPORT_PATCH, checkIn: "ea1d55e202e6e" };

describe("local upstream backports", () => {
	it("reads the real backport patch's upstream check-in from its header", () => {
		const text = readFileSync(new URL(BACKPORT_PATCH, PATCHES_DIR), "utf8");
		expect(parseBackports([{ name: BACKPORT_PATCH, text }])).toEqual([
			BACKPORT,
		]);
	});

	it.each([
		["0003-sahpool-lock-table.patch", "9e2caaa382"],
		["0004-sahpool-xsleep-noop.patch", "c9dd4d88e4"],
	])(
		"reads %s's upstream check-in, so its weekly issue names it too",
		(name, checkIn) => {
			const text = readFileSync(new URL(name, PATCHES_DIR), "utf8");
			expect(parseBackports([{ name, text }])).toEqual([
				{ patch: name, checkIn },
			]);
		},
	);

	it("ignores a local patch that is not an upstream backport", () => {
		const name = "0001-opfs-async-proxy-inline-and-alive.patch";
		const text = readFileSync(new URL(name, PATCHES_DIR), "utf8");
		expect(parseBackports([{ name, text }])).toEqual([]);
	});

	it("tells a newer SQLite's issue to drop the backport once it is included", () => {
		const result = assess(
			PINNED,
			{
				sqlite: { version: "3.53.5", url: "u", sha3: SHA3_A },
				vector: { tag: "1.1.2", commit: COMMIT_PINNED },
				emsdk: EMSDK_CURRENT,
			},
			[BACKPORT],
		);
		expect(result.behind).toBe(true);
		expect(result.body).toContain(BACKPORT_PATCH);
		expect(result.body).toContain("https://sqlite.org/src/info/ea1d55e202e6e");
		expect(result.body).toMatch(/drop|delete/i);
	});

	it("does not open an issue for a backport alone while SQLite is current", () => {
		const result = assess(
			PINNED,
			{
				sqlite: { version: "3.53.4", url: PINNED.sqliteUrl, sha3: SHA3_A },
				vector: { tag: "1.1.2", commit: COMMIT_PINNED },
				emsdk: EMSDK_CURRENT,
			},
			[BACKPORT],
		);
		expect(result.behind).toBe(false);
	});
});

interface Call {
	readonly method: string;
	readonly url: string;
	readonly body: unknown;
}

/** A recording fake of the three GitHub issue endpoints the script uses. */
function fakeGitHub(openIssues: readonly { number: number; title: string }[]) {
	const calls: Call[] = [];
	const fetchImpl = async (
		url: string,
		init: { method?: string; body?: string } = {},
	): Promise<Response> => {
		const method = init.method ?? "GET";
		calls.push({
			method,
			url,
			body: init.body === undefined ? undefined : JSON.parse(init.body),
		});
		const payload = method === "GET" ? openIssues : { number: 99 };
		return new Response(JSON.stringify(payload), { status: 200 });
	};
	return { calls, fetchImpl };
}

describe("upsertIssue", () => {
	const repo = "gainratio/edgeproc-browser";

	it("opens a new issue when none is open", async () => {
		const gh = fakeGitHub([{ number: 3, title: "something else" }]);
		await upsertIssue({ repo, token: "t", body: "b", fetchImpl: gh.fetchImpl });
		const writes = gh.calls.filter((c) => c.method !== "GET");
		expect(writes).toEqual([
			{
				method: "POST",
				url: `https://api.github.com/repos/${repo}/issues`,
				body: { title: ISSUE_TITLE, body: "b" },
			},
		]);
	});

	it("updates the open issue instead of opening a duplicate", async () => {
		const gh = fakeGitHub([{ number: 7, title: ISSUE_TITLE }]);
		await upsertIssue({
			repo,
			token: "t",
			body: "b2",
			fetchImpl: gh.fetchImpl,
		});
		const writes = gh.calls.filter((c) => c.method !== "GET");
		expect(writes).toEqual([
			{
				method: "PATCH",
				url: `https://api.github.com/repos/${repo}/issues/7`,
				body: { body: "b2" },
			},
		]);
	});

	it("fails closed when the API refuses", async () => {
		const fetchImpl = async (): Promise<Response> =>
			new Response("nope", { status: 403 });
		await expect(
			upsertIssue({ repo, token: "t", body: "b", fetchImpl }),
		).rejects.toThrow(/403/);
	});
});

it("pins the exact issue title the task promises", () => {
	expect(ISSUE_TITLE).toBe("SQLite/sqlite-vector update available");
});
