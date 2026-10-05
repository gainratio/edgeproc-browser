// @vitest-environment node
//
// `npm pack --json` changed shape in npm 12: an array of results became an
// object keyed by package name. The 0.3.0 publish ran npm@latest (12.2.0),
// read `packed[0]?.files ?? []`, got [], and failed with "not in the
// tarball" while the tarball was fine. These pin both shapes and make any
// third shape a loud refusal instead of an empty file list.

import { describe, expect, it } from "vitest";
import { packedFiles } from "./npm-pack-json";

const NAME = "@gainratio/browser";
const RESULT = {
	name: NAME,
	filename: "gainratio-browser-0.3.0.tgz",
	files: [{ path: "dist/sql/node.js" }, { path: "package.json" }],
};

describe("packedFiles", () => {
	it("reads the npm <= 11 array shape", () => {
		expect(packedFiles([RESULT], NAME)).toEqual({
			filename: "gainratio-browser-0.3.0.tgz",
			files: ["dist/sql/node.js", "package.json"],
		});
	});

	it("reads the npm 12 object-keyed-by-name shape", () => {
		expect(packedFiles({ [NAME]: RESULT }, NAME)).toEqual({
			filename: "gainratio-browser-0.3.0.tgz",
			files: ["dist/sql/node.js", "package.json"],
		});
	});

	it("refuses an unrecognised shape instead of returning no files", () => {
		expect(() => packedFiles({}, NAME)).toThrow(/npm pack --json/);
		expect(() => packedFiles([], NAME)).toThrow(/npm pack --json/);
		expect(() => packedFiles({ [NAME]: { name: NAME } }, NAME)).toThrow(
			/npm pack --json/,
		);
		expect(() => packedFiles(null, NAME)).toThrow(/npm pack --json/);
	});

	it("refuses a result for a different package", () => {
		expect(() => packedFiles([{ ...RESULT, name: "other" }], NAME)).toThrow(
			/npm pack --json/,
		);
	});
});
