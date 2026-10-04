export declare const ISSUE_TITLE: "SQLite/sqlite-vector update available";

export interface Pinned {
	readonly sqliteUrl: string;
	readonly sqliteVersion: string;
	readonly sqliteSha3: string;
	readonly vectorCommit: string;
	readonly emsdkDigest: string;
}

export interface SqliteRelease {
	readonly version: string;
	readonly url: string;
	readonly sha3: string;
}

export interface VectorRelease {
	readonly tag: string;
	readonly commit: string;
}

export interface EmsdkRelease {
	readonly tag: string;
	readonly digest: string;
	/** The release tag whose digest is pinned, or "unknown". */
	readonly pinnedTag: string;
}

export interface Assessment {
	readonly behind: boolean;
	readonly body: string;
}

export type FetchLike = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
	},
) => Promise<Response>;

/** "sqlite-src-3530400.zip" -> "3.53.4". Throws on any other name. */
export declare function versionFromSrcName(name: string): string;
/** -1, 0 or 1. Throws on anything that is not a dotted numeric version. */
export declare function compareVersions(a: string, b: string): -1 | 0 | 1;
/** The sqlite-src row of the download page's CSV comment block. */
export declare function parseSqliteDownloadPage(html: string): SqliteRelease;
/** The pins in scripts/build-sqlite-vector-wasm.sh. */
export declare function parsePinned(script: string): Pinned;
/** The newest x.y.z emscripten/emsdk tag on a Docker Hub tags page. */
export declare function parseEmsdkTags(
	page: unknown,
	pinnedDigest: string,
): EmsdkRelease;
export declare function assess(
	pinned: Pinned,
	latest: {
		readonly sqlite: SqliteRelease;
		readonly vector: VectorRelease;
		readonly emsdk: EmsdkRelease;
	},
): Assessment;
/** Open the update issue, or update the one already open. Never duplicates. */
export declare function upsertIssue(options: {
	readonly repo: string;
	readonly token: string;
	readonly body: string;
	readonly fetchImpl?: FetchLike;
}): Promise<void>;
