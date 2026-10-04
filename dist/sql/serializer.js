// SQLite's own serialization, bound once from the sqlite-wasm module: export is
// sqlite3_serialize (via sqlite3_js_db_export), import is sqlite3_deserialize
// into an in-memory schema. No dump format: the bytes ARE a SQLite file.
const SQLITE_DESERIALIZE_READONLY = 4;
export function createSqlSerializer(sqlite) {
    const assertOk = (code, call) => {
        if (code !== sqlite.capi.SQLITE_OK) {
            throw new Error(`${call} failed: ${sqlite.capi.sqlite3_errstr(code)}`);
        }
    };
    return {
        serialize: (raw) => sqlite.capi.sqlite3_js_db_export(pointerOf(raw), "main"),
        isComplete: (sql) => sqlite.capi.sqlite3_complete(sql) !== 0,
        keepOnlyModules: (raw, keep) => {
            const scope = sqlite.wasm.scopedAllocPush();
            try {
                const code = sqlite.capi.sqlite3_drop_modules(pointerOf(raw), sqlite.wasm.scopedAllocMainArgv(keep));
                assertOk(code, "sqlite3_drop_modules");
            }
            finally {
                sqlite.wasm.scopedAllocPop(scope);
            }
        },
        scratch: () => new sqlite.oo1.DB(":memory:"),
        deserialize: (raw, schema, bytes, readonly) => {
            const copy = sqlite.wasm.allocFromTypedArray(bytes);
            const size = BigInt(bytes.byteLength);
            const code = sqlite.capi.sqlite3_deserialize(pointerOf(raw), schema, copy, size, size, readonly ? SQLITE_DESERIALIZE_READONLY : 0);
            if (code !== sqlite.capi.SQLITE_OK)
                sqlite.wasm.dealloc(copy);
            assertOk(code, "sqlite3_deserialize");
            return () => sqlite.wasm.dealloc(copy);
        },
    };
}
function pointerOf(raw) {
    if (raw.pointer === undefined) {
        throw new TypeError("SQLite handle has no native pointer");
    }
    return raw.pointer;
}
//# sourceMappingURL=serializer.js.map