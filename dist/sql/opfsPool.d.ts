import { type SqlLocks } from "./open.js";
export type OpfsPoolRemoval = "removed" | "absent" | "in-use";
/** The slice of an OPFS directory handle removal needs. */
export interface OpfsRoot {
    removeEntry(name: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
}
export interface RemoveOpfsPoolOptions {
    /** Defaults to `navigator.storage.getDirectory()`. */
    readonly root?: OpfsRoot;
}
export interface RemoveSqlDatabaseOptions extends RemoveOpfsPoolOptions {
    /** Defaults to `navigator.locks`. */
    readonly locks?: SqlLocks | undefined;
}
/** Remove the opfs-sahpool named `poolName` (its directory `.${poolName}`). */
export declare function removeOpfsPool(poolName: string, options?: RemoveOpfsPoolOptions): Promise<OpfsPoolRemoval>;
/**
 * Remove a database opened with `openSqlDatabase({ name })`. Takes the same
 * owner lock the open holds, so it never deletes a database this origin has
 * open; then removes its pool.
 */
export declare function removeSqlDatabase(name: string, options?: RemoveSqlDatabaseOptions): Promise<OpfsPoolRemoval>;
/** The pool `createSqliteVectorIndex({ name, persistence: "opfs" })` uses. */
export declare function sqliteVectorPoolName(name: string): Promise<string>;
//# sourceMappingURL=opfsPool.d.ts.map