import { describe, expect, it } from "vitest";
import {
	canPromotePointer,
	parseStoredPointer,
	samePointer,
	selectHighestPointer,
} from "./activePointer.js";
import type { VersionPointer } from "./types.js";

const base = {
	manifest_hash: "a".repeat(64),
	version: "v1",
	sequence: 1,
	signature: "signed",
};

describe("durable active pointer parser", () => {
	it("bounds optional signed identity strings", () => {
		expect(
			parseStoredPointer({ ...base, bundle_id: "bundle", channel: null }),
		).toEqual({
			...base,
			bundle_id: "bundle",
			channel: null,
		});
		expect(
			parseStoredPointer({ ...base, bundle_id: "x".repeat(201) }),
		).toBeNull();
		expect(
			parseStoredPointer({ ...base, channel: "x".repeat(201) }),
		).toBeNull();
	});

	it("loads records that predate key_id/expires_at", () => {
		expect(parseStoredPointer(base)).toEqual(base);
	});

	it("keeps well-formed key_id and expires_at", () => {
		const signed = {
			...base,
			key_id: "34750f98bd59fcfc",
			expires_at: 1_767_225_600,
		};
		expect(parseStoredPointer(signed)).toEqual(signed);
		expect(
			parseStoredPointer({ ...base, key_id: null, expires_at: null }),
		).toEqual({ ...base, key_id: null, expires_at: null });
	});

	it.each([
		["an uppercase key_id", { key_id: "34750F98BD59FCFC" }],
		["a short key_id", { key_id: "34750f98" }],
		["a numeric key_id", { key_id: 1 }],
		["a zero expires_at", { expires_at: 0 }],
		["a fractional expires_at", { expires_at: 1.5 }],
		["an unsafe expires_at", { expires_at: 2 ** 53 }],
		["a string expires_at", { expires_at: "1" }],
	])("refuses %s", (_label, field) => {
		expect(parseStoredPointer({ ...base, ...field })).toBeNull();
	});
});

describe("durable pointer equality", () => {
	it("treats absent and null new fields as the same legacy pointer", () => {
		expect(samePointer(base, { ...base, key_id: null, expires_at: null })).toBe(
			true,
		);
	});

	it.each([
		["key_id", { key_id: "34750f98bd59fcfc" }],
		["expires_at", { expires_at: 1_767_225_600 }],
	])("distinguishes pointers that differ only in %s", (_label, field) => {
		expect(samePointer(base, { ...base, ...field })).toBe(false);
		expect(samePointer({ ...base, ...field }, { ...base, ...field })).toBe(
			true,
		);
	});
});

const pointer = (
	sequence: number,
	manifestHash = "a".repeat(64),
): VersionPointer => ({
	manifest_hash: manifestHash,
	version: `v${sequence}`,
	bundle_id: "bundle",
	channel: "stable",
	sequence,
	signature: "signed",
});

/** A pre-sequence (0.1.x) pointer as it sat on disk: no `sequence` field. */
const legacy = (signature: string): VersionPointer =>
	({
		manifest_hash: "a".repeat(64),
		version: "v0",
		signature,
	}) as unknown as VersionPointer;

describe("durable active pointer selection (migration floor)", () => {
	it("keeps the newest valid slot when another slot is torn", () => {
		expect(selectHighestPointer([pointer(4), null, pointer(3)])?.sequence).toBe(
			4,
		);
		expect(selectHighestPointer([null, null])).toBeNull();
	});

	it("rejects equal-sequence disagreement across durable slots", () => {
		expect(() =>
			selectHighestPointer([
				pointer(7),
				{ ...pointer(7), signature: "different-signature" },
			]),
		).toThrow(/disagree at the same sequence/iu);
	});

	it("prefers any sequenced pointer over a sequence-less legacy one", () => {
		expect(selectHighestPointer([legacy("old"), pointer(2)])?.sequence).toBe(2);
		expect(selectHighestPointer([pointer(2), legacy("old")])?.sequence).toBe(2);
	});

	it("accepts agreeing legacy slots and refuses disagreeing ones", () => {
		expect(selectHighestPointer([legacy("same"), legacy("same")])).toEqual(
			legacy("same"),
		);
		expect(() => selectHighestPointer([legacy("one"), legacy("two")])).toThrow(
			/legacy durable active pointers disagree/iu,
		);
	});
});

describe("promotion over a durable pointer", () => {
	it("rejects stale and equal-sequence equivocation", () => {
		const current = pointer(7);
		expect(canPromotePointer(current, pointer(6))).toBe(false);
		expect(canPromotePointer(current, pointer(7, "b".repeat(64)))).toBe(false);
		expect(
			canPromotePointer(current, { ...pointer(7), signature: "different" }),
		).toBe(false);
		expect(canPromotePointer(current, pointer(7))).toBe(true);
		expect(canPromotePointer(current, pointer(8))).toBe(true);
	});

	it("lets the first sequenced release replace nothing or a legacy pointer once", () => {
		expect(canPromotePointer(null, pointer(1))).toBe(true);
		expect(canPromotePointer(legacy("old"), pointer(1))).toBe(true);
	});
});
