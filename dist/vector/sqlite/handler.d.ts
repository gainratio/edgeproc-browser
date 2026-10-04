import type { SqliteDatabaseVectorIndex } from "./database.js";
import type { SqliteVectorWorkerOptions, SqliteVectorWorkerRequest, SqliteVectorWorkerResponse } from "./protocol.js";
/** The index methods the protocol reaches. */
export type VectorWorkerIndex = Pick<SqliteDatabaseVectorIndex, "capabilities" | "insert" | "insertKeyed" | "read" | "search" | "searchByIds" | "lookupIds" | "delete" | "deleteWhere" | "clear" | "stats" | "runtimeInfo" | "dispose">;
export interface OpenedVectorIndex {
    readonly index: VectorWorkerIndex;
    /** Free whatever the open acquired (OPFS handles, owner lock); resolves once free. */
    release(): Promise<void>;
}
export type VectorIndexOpener = (options: SqliteVectorWorkerOptions) => Promise<OpenedVectorIndex>;
export declare function createVectorWorkerHandler(open: VectorIndexOpener): (request: SqliteVectorWorkerRequest) => Promise<SqliteVectorWorkerResponse>;
//# sourceMappingURL=handler.d.ts.map