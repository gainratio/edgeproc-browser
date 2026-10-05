// Move a database out of an opfs-sahpool another SQLite build left behind
// (e.g. an app's own @sqlite.org/sqlite-wasm pool) into a database this
// library owns, inside the SQL Worker.
//
// 1. Exclusive: hold a Web Lock, then install the legacy pool, which opens
//    every one of its OPFS sync access handles. An old-build tab that still
//    has the pool open makes that fail (reported "in-use"); once we hold the
//    handles, an old-build tab cannot open them, so nothing writes mid-read.
// 2. Recovery: the pools this migrates were written by OLD builds, whose
//    opfs-sahpool xCheckReservedLock always answered "locked", so SQLite never
//    treated a journal inside them as hot. This library's build has the fix
//    (local patch 0002), but the input is an old build's pool, possibly torn
//    by a crash, and the migration must not depend on which build reads it.
//    The database and its rollback journal are therefore opened together
//    through SQLite's "unix" VFS (in-memory files), where SQLite's own
//    hot-journal rollback runs, and the result is serialized.
// 3. Atomic: the recovered file goes through the normal import (validation,
//    then one transaction). The legacy pool is removed only on request, and
//    only after that import committed.
import { acquirePoolLease, isPoolContentionError, poolOwnerLock, } from "./open.js";
import { SqlStorageUnavailableError, } from "./types.js";
const SAFE_POOL_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const IN_USE = { status: "in-use" };
const ABSENT = { status: "absent" };
export async function migrateLegacySahPool(deps, request) {
    assertRequest(deps, request);
    return withLock(deps, request.lockName ?? poolOwnerLock(request.fromPool), async () => {
        if (!(await deps.poolExists(request.fromPool)))
            return ABSENT;
        const pool = await install(deps, request.fromPool);
        if (pool === undefined)
            return IN_USE;
        return migrateFrom(deps, pool, request);
    });
}
function assertRequest(deps, request) {
    const { fromPool, fromFile } = request;
    if (!SAFE_POOL_NAME.test(fromPool) || fromPool === "..") {
        throw new TypeError(`invalid legacy pool name: ${JSON.stringify(fromPool)}`);
    }
    if (fromFile === "")
        throw new TypeError("legacy file name is empty");
    if (deps.ownPool === undefined) {
        throw new SqlStorageUnavailableError("opfs-unavailable", "refusing to migrate a legacy pool into a database that is not on OPFS");
    }
    if (fromPool === deps.ownPool) {
        throw new TypeError("the legacy pool is this database's own pool");
    }
}
async function install(deps, name) {
    try {
        const pool = await deps.installPool(name);
        // A pool an earlier migration in this Worker paused is memoised paused.
        if (pool.isPaused())
            await pool.unpauseVfs();
        return pool;
    }
    catch (error) {
        if (isPoolContentionError(error))
            return undefined;
        throw error;
    }
}
async function migrateFrom(deps, pool, request) {
    try {
        const files = pool.getFileNames();
        const { fromFile } = request;
        if (!files.includes(fromFile))
            return ABSENT;
        if (files.includes(`${fromFile}-wal`)) {
            throw new Error(`legacy database ${fromFile} has a WAL file; open it once with its own build to checkpoint it`);
        }
        const journalName = `${fromFile}-journal`;
        const journal = files.includes(journalName)
            ? pool.exportFile(journalName)
            : undefined;
        const bytes = deps.recover(pool.exportFile(fromFile), journal);
        const result = deps.importDatabase(bytes, request.importOptions);
        return {
            status: "migrated",
            result,
            recoveredJournal: journal !== undefined && journal.byteLength > 0,
            legacy: request.removeLegacy === true
                ? await removeLegacy(deps, pool, request, files)
                : "kept",
        };
    }
    finally {
        if (!pool.isPaused())
            pool.pauseVfs();
    }
}
/**
 * removeVfs() deletes the whole pool, so only when it holds nothing but this
 * database and its journal; otherwise nothing is deleted ("shared").
 */
async function removeLegacy(deps, pool, request, files) {
    const own = new Set([request.fromFile, `${request.fromFile}-journal`]);
    if (files.some((file) => !own.has(file)))
        return "shared";
    await pool.removeVfs();
    return (await deps.poolExists(request.fromPool)) ? "kept" : "removed";
}
/** Run `action` under an exclusive lock; "in-use" if it stays taken. */
async function withLock(deps, name, action) {
    const release = await acquirePoolLease(deps.locks, name, deps.lockWaitMs);
    if (release === undefined)
        return IN_USE;
    try {
        return await action();
    }
    finally {
        await release();
    }
}
/** Does the pool's directory exist? Never creates it. */
export async function opfsPoolExists(pool, root) {
    try {
        await root.getDirectoryHandle(`.${pool}`, { create: false });
        return true;
    }
    catch (error) {
        if (error?.name === "NotFoundError") {
            return false;
        }
        throw error;
    }
}
/** Narrow an initialised sqlite-wasm module to the slice recovery needs. */
export function isSqlRecoveryModule(module) {
    const m = module;
    return (typeof m.oo1?.DB === "function" &&
        typeof m.capi?.sqlite3_js_posix_create_file === "function" &&
        typeof m.capi.sqlite3_js_db_export === "function" &&
        typeof m.capi.sqlite3_vfs_find === "function" &&
        typeof m.wasm?.xWrap === "function");
}
/** Narrow sqlite3.mjs's opfs-sahpool PoolUtil to the slice migration uses. */
export function asLegacySahPool(util) {
    const methods = [
        "getFileNames",
        "exportFile",
        "isPaused",
        "unpauseVfs",
        "pauseVfs",
        "removeVfs",
    ];
    const missing = methods.filter((name) => typeof util[name] !== "function");
    if (missing.length > 0) {
        throw new TypeError(`opfs-sahpool PoolUtil lacks ${missing.join(", ")}`);
    }
    return util;
}
let scratchSerial = 0;
function nextScratchFile() {
    scratchSerial += 1;
    return `/tmp/edgeproc-legacy-${scratchSerial}.sqlite3`;
}
/**
 * `(database, journal?) => bytes`: let SQLite play a rollback journal back
 * onto the database, through the "unix" VFS on in-memory files, and return
 * the recovered file. Without a journal the bytes are returned as they are.
 */
export function createJournalRecovery(module, scratchFile = nextScratchFile) {
    if (!isSqlRecoveryModule(module)) {
        throw new TypeError("sqlite-wasm module lacks the unix VFS file APIs");
    }
    const sqlite = module;
    const unlink = sqlite.wasm.xWrap("sqlite3__wasm_vfs_unlink", "int", [
        "*",
        "string",
    ]);
    return (database, journal) => {
        if (journal === undefined)
            return database;
        const file = scratchFile();
        const vfs = sqlite.capi.sqlite3_vfs_find("unix");
        try {
            sqlite.capi.sqlite3_js_posix_create_file(file, database);
            sqlite.capi.sqlite3_js_posix_create_file(`${file}-journal`, journal);
            const raw = new sqlite.oo1.DB({
                filename: file,
                flags: "w",
                vfs: "unix",
            });
            try {
                // The first read takes the shared lock, finds the hot journal and
                // rolls it back (SQLite's own recovery), deleting the journal.
                raw.exec("SELECT count(*) FROM sqlite_schema");
                return sqlite.capi.sqlite3_js_db_export(raw.pointer);
            }
            finally {
                raw.close();
            }
        }
        finally {
            unlink(vfs, `${file}-journal`);
            unlink(vfs, file);
        }
    };
}
//# sourceMappingURL=legacy.js.map