import { type MemoryProfileSetting } from "../sqlite/memoryProfile.js";
import { type SqlDatabase } from "./client.js";
export type { SqlDatabase } from "./client.js";
export interface OpenNodeSqlDatabaseOptions {
    /** A label for this database (each call opens a new, empty one). */
    readonly name: string;
    /** SQLite page cache / heap limits. Default "auto". */
    readonly memoryProfile?: MemoryProfileSetting;
}
/**
 * Open a new in-memory database on the library's pinned SQLite build, in
 * this process. Same {@link SqlDatabase} API as `openSqlDatabase`; OPFS-only
 * calls (legacy pool migration) reject.
 */
export declare function openNodeSqlDatabase(options: OpenNodeSqlDatabaseOptions): Promise<SqlDatabase>;
//# sourceMappingURL=node.d.ts.map