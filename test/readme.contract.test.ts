// @vitest-environment node
//
// README contract: the README stays plain, true, and wired to real files.
// It is deliberately dumb (string and regex checks, no markdown parser),
// because its job is to stop drift: the tagline vs package metadata, the
// section order, a stale "not on npm yet" claim, jargon creeping back in, or a
// dead link. It does not judge prose.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const PACKAGE = JSON.parse(
	readFileSync(join(ROOT, "package.json"), "utf8"),
) as {
	name: string;
	description: string;
};
const TAGLINE_LIMIT = 140;
const BADGE_LIMIT = 3;
const EM_DASH_LIMIT = 4;
const SECTIONS = [
	"## Try it",
	"## How it works",
	"## What it does not do",
	"## When to use something else",
	"## Install",
	"## Develop",
	"## More detail",
	"## License",
];
const ARCHITECTURE = "docs/ARCHITECTURE.md";
const GETTING_STARTED = "docs/GETTING_STARTED.md";
const ARCHITECTURE_MAP = "docs/architecture/index.html";
const ARCHITECTURE_SOURCE = "docs/architecture/runtime.architecture.json";
const SCREENSHOTS = [
	"docs/assets/try-it-verified.png",
	"docs/assets/try-it-refused.png",
];
// Real output from running the Try it steps against @edgeproc/browser 0.1.0
// from npm, in headless Chromium and in Node.
const REAL_OUTPUT = [
	"verified v1 (1 fetched, 0 reused)",
	'{"sku": "A-100", "name": "Blue mug", "price": 12.5}',
	"refused (integrity): chunk 34fa454858ceada20cfa0cd5236eb70f90e1021ed3bd03a6c9d5332597b3cc12 failed content-address check",
	"verified v1 (0 fetched, 1 reused)",
];
// Internal vocabulary, hype, and the old template's headings. `pnpm gate` is
// the real command name, so it is removed before the "gate" check.
const BANNED = [
	/\bnorthstar\b/i,
	/\bseams?\b/i,
	/\blego\b/i,
	/trust envelope/i,
	/\breceipts?\b/i,
	/fail[- ]closed/i,
	/\bgate\b/i,
	/\bfleet\b/i,
	/\bportfolio\b/i,
	/production-ready/i,
	/\brobust\b/i,
	/\bblazing/i,
	/enterprise-grade/i,
	/\bseamless/i,
	/At a glance/,
	/Try it in 60 seconds/,
	/not (yet )?published/i,
	/not yet tagged/i,
];
// [text](target): the target stops at whitespace or ")"; a "title" is ignored.
const LINK = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const lines = README.split("\n");
const section = (heading: string): string => {
	const start = README.indexOf(`\n${heading}\n`);
	const next = README.indexOf("\n## ", start + 1);
	return start < 0 ? "" : README.slice(start, next < 0 ? undefined : next);
};
const intro = README.split("\n## ")[0] ?? "";
const links = [...README.matchAll(LINK)].map(([, text = "", target = ""]) => ({
	text,
	target,
}));
const targetsIn = (text: string): string[] =>
	[...text.matchAll(LINK)].map(([, , target = ""]) => target);
const relativeTargets = [
	...new Set(
		links
			.map(({ target }) => target)
			.filter(
				(target) =>
					!/^[a-z][a-z0-9+.-]*:/.test(target) && !target.startsWith("#"),
			)
			.map((target) => target.split("#")[0] ?? target),
	),
].sort();

describe("README contract", () => {
	it("opens with the package name", () => {
		expect(lines[0]).toBe(`# ${PACKAGE.name}`);
	});

	it("follows the title with one plain sentence equal to the package description", () => {
		const tagline = lines.slice(1).find((line) => line.trim() !== "");
		expect(tagline).toBe(PACKAGE.description);
		expect(PACKAGE.description.length).toBeLessThanOrEqual(TAGLINE_LIMIT);
		expect(PACKAGE.description).toMatch(/^For web developers: /);
	});

	it("puts the one-line npm install in bold right under the tagline", () => {
		const next = lines
			.slice(1)
			.filter((line) => line.trim() !== "")
			.slice(1, 2)[0];
		expect(next).toContain(`**\`npm install ${PACKAGE.name}\`**`);
	});

	it("carries at most three badges", () => {
		expect(README.split("[![").length - 1).toBeLessThanOrEqual(BADGE_LIMIT);
	});

	it("links Architecture and Getting started on the Technical docs line in the intro", () => {
		const docsLine = intro
			.split("\n")
			.find((line) => line.startsWith("**Technical docs:**"));
		expect(docsLine).toBeDefined();
		const targets = targetsIn(docsLine ?? "");
		expect(targets).toContain(ARCHITECTURE);
		expect(targets).toContain(GETTING_STARTED);
	});

	it("has every required section, in order", () => {
		const positions = SECTIONS.map((heading) =>
			README.indexOf(`\n${heading}\n`),
		);
		for (const position of positions) expect(position).toBeGreaterThan(-1);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	});

	it.each(REAL_OUTPUT)("shows the real output line %s in Try it", (line) => {
		expect(section("## Try it")).toContain(line);
	});

	it.each(SCREENSHOTS)("shows the real screenshot %s in Try it", (path) => {
		expect(targetsIn(section("## Try it"))).toContain(path);
		expect(existsSync(join(ROOT, path))).toBe(true);
	});

	it("installs from npm and names the published version it documents", () => {
		expect(section("## Install")).toContain(`npm install ${PACKAGE.name}`);
		expect(README).toContain("0.1.0");
	});

	it("links Getting started from Develop", () => {
		expect(targetsIn(section("## Develop"))).toContain(GETTING_STARTED);
	});

	it("links every technical doc from More detail", () => {
		const targets = targetsIn(section("## More detail"));
		for (const doc of [
			ARCHITECTURE,
			GETTING_STARTED,
			ARCHITECTURE_MAP,
			"docs/sqlite-state.md",
			"docs/dependencies.md",
			"SECURITY.md",
			"CONTRIBUTING.md",
			"CHANGELOG.md",
		])
			expect(targets).toContain(doc);
		expect(existsSync(join(ROOT, ARCHITECTURE_SOURCE))).toBe(true);
	});

	it("says MIT in License", () => {
		expect(section("## License")).toContain("MIT");
	});

	it.each(BANNED.map((pattern) => [String(pattern), pattern] as const))(
		"does not use %s",
		(_name, pattern) => {
			expect(README.replaceAll("pnpm gate", "pnpm check")).not.toMatch(pattern);
		},
	);

	it("keeps em-dashes rare", () => {
		expect(README.split("—").length - 1).toBeLessThanOrEqual(EM_DASH_LIMIT);
	});

	it("finds relative links to check", () => {
		expect(relativeTargets).toContain(ARCHITECTURE);
	});

	it.each(relativeTargets)("resolves the relative link %s", (target) => {
		expect(existsSync(join(ROOT, target))).toBe(true);
	});
});
