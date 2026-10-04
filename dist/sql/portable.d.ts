import type { SqlRawDatabase } from "./engine.js";
import type { SqlSerializer } from "./serializer.js";
import { type SqlImportOptions, type SqlImportResult } from "./types.js";
export declare const DEFAULT_MAX_IMPORT_BYTES: number;
export declare function exportDatabase(raw: SqlRawDatabase, serializer: SqlSerializer): Uint8Array;
export declare function importDatabase(raw: SqlRawDatabase, serializer: SqlSerializer, input: Uint8Array, options?: SqlImportOptions): SqlImportResult;
/**
 * Parse the head of one stored CREATE: undefined unless it is the allowed
 * form for its type and names exactly `row.name`, unqualified. For a virtual
 * table, also the module it names (lower case).
 */
export declare function createHead(row: SchemaRow): {
    readonly module?: string;
} | undefined;
export type SchemaRow = {
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
};
//# sourceMappingURL=portable.d.ts.map