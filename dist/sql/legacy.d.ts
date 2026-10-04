import { type SqlLocks } from "./open.js";
import { type LegacySahPoolMigration, type MigrateLegacySahPoolOptions, type SqlImportOptions, type SqlImportResult } from "./types.js";
/** The slice of sqlite3.mjs's opfs-sahpool PoolUtil the migration uses. */
export interface LegacySahPool {
    getFileNames(): string[];
    exportFile(name: string): Uint8Array;
    isPaused(): boolean;
    unpauseVfs(): Promise<unknown>;
    pauseVfs(): unknown;
    removeVfs(): Promise<boolean>;
}
export interface LegacyMigrationDeps {
    readonly locks: SqlLocks | undefined;
    readonly lockWaitMs: number;
    /** The target's own pool; undefined when the target is not on OPFS. */
    readonly ownPool: string | undefined;
    poolExists(pool: string): Promise<boolean>;
    installPool(pool: string): Promise<LegacySahPool>;
    recover(database: Uint8Array, journal: Uint8Array | undefined): Uint8Array;
    importDatabase(bytes: Uint8Array, options?: SqlImportOptions): SqlImportResult;
}
export declare function migrateLegacySahPool(deps: LegacyMigrationDeps, request: MigrateLegacySahPoolOptions): Promise<LegacySahPoolMigration>;
/** The slice of an OPFS directory handle {@link opfsPoolExists} needs. */
export interface OpfsDirectory {
    getDirectoryHandle(name: string, options?: {
        readonly create?: boolean;
    }): Promise<unknown>;
}
/** Does the pool's directory exist? Never creates it. */
export declare function opfsPoolExists(pool: string, root: OpfsDirectory): Promise<boolean>;
/** The slice of the sqlite-wasm module journal recovery needs. */
export interface SqlRecoveryModule {
    readonly oo1: {
        readonly DB: new (options: {
            readonly filename: string;
            readonly flags: string;
            readonly vfs: string;
        }) => {
            readonly pointer: number | bigint;
            exec(sql: string): unknown;
            close(): void;
        };
    };
    readonly capi: {
        sqlite3_js_posix_create_file(filename: string, data: Uint8Array): void;
        sqlite3_js_db_export(database: number | bigint): Uint8Array;
        sqlite3_vfs_find(name: string): number | bigint;
    };
    readonly wasm: {
        xWrap(name: string, result: string, args: ReadonlyArray<string>): (vfs: number | bigint, filename: string) => number;
    };
}
/** Narrow an initialised sqlite-wasm module to the slice recovery needs. */
export declare function isSqlRecoveryModule(module: object): module is SqlRecoveryModule;
/** Narrow sqlite3.mjs's opfs-sahpool PoolUtil to the slice migration uses. */
export declare function asLegacySahPool(util: object): LegacySahPool;
/**
 * `(database, journal?) => bytes`: let SQLite play a rollback journal back
 * onto the database, through the "unix" VFS on in-memory files, and return
 * the recovered file. Without a journal the bytes are returned as they are.
 */
export declare function createJournalRecovery(module: object, scratchFile?: () => string): (database: Uint8Array, journal?: Uint8Array) => Uint8Array;
//# sourceMappingURL=legacy.d.ts.map