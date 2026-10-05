import { describe, expect, it } from "vitest";
import { SqlStorageUnavailableError } from "../sql/types.js";
import { SignatureError } from "./crypto.js";
import {
	classifyEngineError,
	EngineOperationError,
	EngineStorageUnavailableError,
	engineErrorOf,
} from "./engineError.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError } from "./integrity.js";
import {
	CacheFallbackRefusedError,
	refuseWithoutFallback,
	StorageQuotaError,
} from "./storageError.js";
import { RollbackError } from "./sync.js";

describe("typed Worker error contract", () => {
	it.each([
		[new RollbackError("old"), "rollback"],
		[new SignatureError("bad signature"), "integrity"],
		[new IntegrityError("bad hash"), "integrity"],
		[new NetworkError("offline"), "network"],
		[new StorageQuotaError(), "storage"],
		[new Error("timed out acquiring OPFS mutation lock"), "lock"],
		[new Error("OPFS initialization failed"), "storage"],
		[new Error("surprise"), "internal"],
	] as const)("classifies %s", (error, code) => {
		expect(classifyEngineError(error)).toEqual({
			code,
			message: error.message,
		});
	});

	it("preserves a stable code on the main-thread error", () => {
		const error = new EngineOperationError({
			code: "network",
			message: "offline",
		});
		expect(error).toMatchObject({
			name: "EngineOperationError",
			code: "network",
			message: "offline",
		});
	});
});

describe("storage-unavailable error contract", () => {
	// 0.3.0 contract, pinned: the default mode's own refusals (pool held by
	// another context, persisted cache unreadable) classify as "internal" with
	// no reason. 0.3.1 is additive, so they must not change.
	it.each([
		[
			"pool-in-use",
			"chunk database is held by another context (another context owns it); retry",
		],
		[
			"opfs-unavailable",
			"chunk database exists on disk but could not be opened (NotAllowedError: x); refusing to run without its rollback floor",
		],
	] as const)(
		"keeps the 0.3.0 classification of a default-mode %s refusal",
		(reason, message) => {
			const detail = classifyEngineError(
				new SqlStorageUnavailableError(reason, message),
			);
			expect(detail).toEqual({ code: "internal", message });
			const error = engineErrorOf(detail);
			expect(error.name).toBe("EngineOperationError");
			expect(error).not.toBeInstanceOf(EngineStorageUnavailableError);
		},
	);

	it('classifies a cacheFallback "none" refusal as storage with its reason', () => {
		expect(
			classifyEngineError(
				new CacheFallbackRefusedError("pool-in-use", "held elsewhere"),
			),
		).toEqual({
			code: "storage",
			message: "held elsewhere",
			reason: "pool-in-use",
		});
	});

	it("turns only an OPFS refusal into CacheFallbackRefusedError", async () => {
		const refused = new SqlStorageUnavailableError(
			"opfs-unavailable",
			"no OPFS",
		);
		await expect(
			refuseWithoutFallback(() => Promise.reject(refused)),
		).rejects.toMatchObject({
			name: "CacheFallbackRefusedError",
			reason: "opfs-unavailable",
			message: "no OPFS",
			cause: refused,
		});
		const other = new Error("boom");
		await expect(
			refuseWithoutFallback(() => Promise.reject(other)),
		).rejects.toBe(other);
		await expect(refuseWithoutFallback(async () => 7)).resolves.toBe(7);
	});

	it("rebuilds a typed EngineStorageUnavailableError on the main thread", () => {
		const error = engineErrorOf({
			code: "storage",
			message: "no OPFS",
			reason: "opfs-unavailable",
		});
		expect(error).toBeInstanceOf(EngineStorageUnavailableError);
		expect(error).toBeInstanceOf(EngineOperationError);
		expect(error).toMatchObject({
			name: "EngineStorageUnavailableError",
			code: "storage",
			reason: "opfs-unavailable",
			message: "no OPFS",
		});
	});

	it("keeps a storage error without a reason a plain EngineOperationError", () => {
		const error = engineErrorOf({ code: "storage", message: "quota" });
		expect(error).not.toBeInstanceOf(EngineStorageUnavailableError);
		expect(error).toMatchObject({
			name: "EngineOperationError",
			code: "storage",
		});
	});
});
