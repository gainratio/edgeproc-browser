// Reads `npm pack --json` output across npm majors, failing closed.
//
// npm <= 11 prints an array of pack results; npm 12 prints an object keyed by
// package name. Anything else is a refusal: an empty file list must never be
// the fallback, because that turns "I could not parse npm" into "the tarball
// is missing files" (or, worse, into a vacuous pass for a negative check).

export interface PackedTarball {
	filename: string;
	files: string[];
}

interface PackResult {
	name: string;
	filename: string;
	files: Array<{ path: string }>;
}

function isPackResult(value: unknown): value is PackResult {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<PackResult>;
	return (
		typeof candidate.name === "string" &&
		typeof candidate.filename === "string" &&
		Array.isArray(candidate.files) &&
		candidate.files.every((file) => typeof file?.path === "string")
	);
}

function pickResult(json: unknown, name: string): unknown {
	if (Array.isArray(json)) return json.length === 1 ? json[0] : undefined;
	if (typeof json === "object" && json !== null) {
		return (json as Record<string, unknown>)[name];
	}
	return undefined;
}

export function packedFiles(json: unknown, name: string): PackedTarball {
	const result = pickResult(json, name);
	if (!isPackResult(result) || result.name !== name) {
		throw new Error(
			`unrecognised npm pack --json output for ${name}: ${JSON.stringify(json)?.slice(0, 200)}`,
		);
	}
	return {
		filename: result.filename,
		files: result.files.map((file) => file.path),
	};
}

// npm exports its effective config to lifecycle scripts as npm_config_*. When
// this test runs inside `npm publish --dry-run`'s prepublishOnly, the nested
// `npm pack` would inherit dry_run=true and write no tarball. The nested pack
// must be governed by its own argv, not by whichever npm command wraps it.
export function isolatedPackEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(
			([key]) => !key.toLowerCase().startsWith("npm_config_"),
		),
	);
}
