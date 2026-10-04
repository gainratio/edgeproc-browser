export declare const CI_WORKFLOW: "ci.yml";
export declare const RELEASE_BRANCH: "main";

/** The slice of a GitHub workflow run the gate reads. */
export interface WorkflowRun {
	readonly id: number;
	readonly run_number: number;
	readonly head_sha: string;
	readonly event: string;
	readonly head_branch: string | null;
	readonly status: string | null;
	readonly conclusion: string | null;
	readonly html_url?: string;
}

export interface ReleaseFacts {
	readonly tag: string;
	readonly packageVersion: string;
	readonly sha: string;
	/** GitHub compare of main...sha; "identical" or "behind" = on main. */
	readonly comparison: { readonly status?: string } | undefined;
	readonly ciRuns: ReadonlyArray<WorkflowRun> | undefined;
}

export type GithubApi = (path: string) => Promise<unknown>;

/** Reasons to refuse; empty means the release may publish. */
export declare function evaluateRelease(facts: ReleaseFacts): string[];
export declare function verifyRelease(options: {
	readonly repo: string;
	readonly sha: string;
	readonly tag: string;
	readonly packageVersion: string;
	readonly api: GithubApi;
}): Promise<string[]>;
export declare function githubApi(
	token: string,
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
): GithubApi;
export declare function releaseContext(
	env: Readonly<Record<string, string | undefined>>,
	root: string,
): {
	readonly token: string;
	readonly repo: string;
	readonly sha: string;
	readonly tag: string;
	readonly packageVersion: string;
};
/** Exit code: 0 = publish may proceed, 1 = refused. */
export declare function main(
	env?: Readonly<Record<string, string | undefined>>,
	root?: string,
	fetchImpl?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<0 | 1>;
