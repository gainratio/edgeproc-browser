// Transaction state and transaction-control refusal, bound once from the
// sqlite-wasm module: sqlite3_get_autocommit says whether a transaction is
// still open, and an authorizer denies BEGIN/COMMIT/ROLLBACK/SAVEPOINT while
// an interactive transaction's own statements are prepared.
/** Narrow an initialised sqlite-wasm module to the slice this needs. */
export function isSqlControlModule(module) {
    const capi = module.capi;
    return (typeof capi?.sqlite3_get_autocommit === "function" &&
        typeof capi.sqlite3_set_authorizer === "function" &&
        typeof capi.SQLITE_TRANSACTION === "number" &&
        typeof capi.SQLITE_SAVEPOINT === "number");
}
export function createSqlConnectionControl(module) {
    if (!isSqlControlModule(module)) {
        throw new TypeError("sqlite-wasm module lacks autocommit/authorizer APIs");
    }
    const { capi } = module;
    const deny = (_user, action) => action === capi.SQLITE_TRANSACTION || action === capi.SQLITE_SAVEPOINT
        ? capi.SQLITE_DENY
        : capi.SQLITE_OK;
    return {
        inTransaction: (raw) => capi.sqlite3_get_autocommit(pointerOf(raw)) === 0,
        withoutTransactionControl: (raw, work) => {
            capi.sqlite3_set_authorizer(pointerOf(raw), deny, 0);
            try {
                return work();
            }
            finally {
                capi.sqlite3_set_authorizer(pointerOf(raw), 0, 0);
            }
        },
    };
}
function pointerOf(raw) {
    if (raw.pointer === undefined) {
        throw new TypeError("SQLite handle has no native pointer");
    }
    return raw.pointer;
}
//# sourceMappingURL=control.js.map