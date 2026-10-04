// Where a named SQL database lives: its own opfs-sahpool VFS in OPFS, owned by
// exactly one context at a time.
//
// opfs-sahpool pre-opens exclusive sync access handles, so only one tab (or
// Worker) per origin can have a pool installed; SQLite leaves that coordination
// to the application. We take it with an exclusive Web Lock held for the life
// of the connection. A second tab waits briefly (a reload overlaps the old page
// for a moment), then either fails closed or, if the caller allowed it, opens
// an in-memory database and SAYS SO in its storage status.
import { SqlStorageUnavailableError, } from "./types.js";
export const SQL_POOL_PREFIX = "edgeproc-sql-";
/** The opfs-sahpool VFS name a database name maps to (OPFS dir: `.${pool}`). */
export async function sqlDatabasePoolName(name) {
    return `${SQL_POOL_PREFIX}${await stableIdentity(name)}`;
}
export async function openSqlStorage(deps, options) {
    const persistence = options.persistence ?? "opfs";
    if (persistence === "memory") {
        return {
            raw: deps.openMemory(),
            storage: { persistence: "memory", reason: "requested" },
            release: () => undefined,
        };
    }
    if (persistence !== "opfs") {
        throw new TypeError(`unsupported SQL persistence: ${String(persistence)}`);
    }
    const pool = await sqlDatabasePoolName(options.name);
    const release = await acquireLease(deps, `${pool}-owner`);
    if (release === undefined) {
        return fallBack(deps, options, "pool-in-use", "another context owns it");
    }
    try {
        const vfs = await deps.installPool(pool);
        const file = `/${pool}.sqlite3`;
        return {
            raw: new vfs.OpfsSAHPoolDb(file),
            storage: { persistence: "opfs", pool, file },
            // Free the handles BEFORE the lock, so the next owner (a reopen, a
            // reloaded tab) can open them the moment it gets the lock.
            release: () => {
                try {
                    vfs.pauseVfs?.();
                }
                finally {
                    release();
                }
            },
        };
    }
    catch (error) {
        release();
        const reason = isPoolContentionError(error)
            ? "pool-in-use"
            : "opfs-unavailable";
        return fallBack(deps, options, reason, describe(error));
    }
}
function fallBack(deps, options, reason, detail) {
    const message = `SQL database "${options.name}" could not use OPFS (${reason}: ${detail})`;
    if ((options.fallback ?? "none") !== "memory") {
        throw new SqlStorageUnavailableError(reason, message);
    }
    deps.warn(`${message}; opened in memory instead`);
    return {
        raw: deps.openMemory(),
        storage: { persistence: "memory", reason, detail },
        release: () => undefined,
    };
}
/** Hold an exclusive lock until the returned release() is called. */
function acquireLease(deps, name) {
    const locks = deps.locks;
    if (locks === undefined)
        return Promise.resolve(() => undefined);
    let release = () => undefined;
    const held = new Promise((resolve) => {
        release = resolve;
    });
    return new Promise((resolve, reject) => {
        locks
            .request(name, { mode: "exclusive", signal: AbortSignal.timeout(deps.lockWaitMs) }, async () => {
            resolve(release);
            await held;
        })
            .catch((error) => {
            if (isTimeout(error))
                resolve(undefined);
            else
                reject(error);
        });
    });
}
/** DOMException is not an Error subclass in every realm, so match by name. */
function isTimeout(error) {
    const name = error?.name;
    return name === "AbortError" || name === "TimeoutError";
}
function isPoolContentionError(error) {
    return (error instanceof Error &&
        (error.name === "NoModificationAllowedError" ||
            /access handles? cannot be created|NoModificationAllowedError/i.test(error.message)));
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
export async function stableIdentity(name) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));
    return [...digest]
        .slice(0, 16)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
}
//# sourceMappingURL=open.js.map