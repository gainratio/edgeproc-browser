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
    /** Defaults to `navigator.locks`; `undefined` removes without the owner lock. */
    readonly locks?: SqlLocks | undefined;
    /** How long to wait for a closing owner before reporting "in-use". Default 2000. */
    readonly lockWaitMs?: number;
}
export type RemoveSqlDatabaseOptions = RemoveOpfsPoolOptions;
/** Remove the opfs-sahpool named `poolName` (its directory `.${poolName}`). */
export declare function removeOpfsPool(poolName: string, options?: RemoveOpfsPoolOptions): Promise<OpfsPoolRemoval>;
/**
 * Remove a database opened with `openSqlDatabase({ name })`: its pool, under
 * the same owner lock the open holds (see {@link removeOpfsPool}).
 */
export declare function removeSqlDatabase(name: string, options?: RemoveSqlDatabaseOptions): Promise<OpfsPoolRemoval>;
/** The pool `createSqliteVectorIndex({ name, persistence: "opfs" })` uses. */
export declare function sqliteVectorPoolName(name: string): Promise<string>;
//# sourceMappingURL=opfsPool.d.ts.map