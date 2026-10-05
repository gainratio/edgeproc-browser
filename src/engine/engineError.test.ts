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
import { StorageQuotaError } from "./storageError.js";
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
	it("classifies a refused SQL store as storage with its reason", () => {
		expect(
			classifyEngineError(
				new SqlStorageUnavailableError("pool-in-use", "held elsewhere"),
			),
		).toEqual({
			code: "storage",
			message: "held elsewhere",
			reason: "pool-in-use",
		});
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
