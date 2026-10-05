import type { VersionPointer } from "./types.js";
/** Parse untrusted durable state without granting it rollback authority. */
export declare function parseStoredPointer(value: unknown): VersionPointer | null;
export declare function samePointer(left: VersionPointer | null, right: VersionPointer): boolean;
/** Absent/null, or exactly 16 lowercase hex characters. */
export declare function optionalKeyId(value: unknown): boolean;
/** Absent/null, or a safe integer Unix-seconds deadline strictly above 0. */
export declare function optionalExpiry(value: unknown): boolean;
/** Select the newest structurally valid durable pointer after a torn write. */
export declare function selectHighestPointer(candidates: ReadonlyArray<VersionPointer | null>): VersionPointer | null;
/** A promotion may only advance the durable identity, never fork it. */
export declare function canPromotePointer(current: VersionPointer | null, incoming: VersionPointer): boolean;
//# sourceMappingURL=activePointer.d.ts.map