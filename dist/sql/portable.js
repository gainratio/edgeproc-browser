// Whole-database export and import, inside the Worker, on one connection.
//
// Export: sqlite3_serialize of `main` — the bytes are a plain SQLite file any
// SQLite tool can open.
//
// Import, in two phases so nothing is touched until the file is proven good:
//   1. VALIDATE in a private scratch connection: the header and size, then
//      PRAGMA integrity_check, application_id, user_version and the caller's
//      read-only checks.
//   2. SWAP in ONE `BEGIN IMMEDIATE` transaction on the live connection: the
//      validated bytes are deserialized into an ATTACHed in-memory schema, the
//      old objects are dropped and the new ones created and copied with SQL.
//      Any failure — disk
//      full half-way, a missing module — rolls the whole thing back, and the
//      rollback journal makes that hold across a crash too.
// The pinned build does not export the sqlite3_backup_* API, so phase 2 is the
// transactional equivalent of a backup step, written in SQL.
import { SqlImportRejectedError, } from "./types.js";
export const DEFAULT_MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const INCOMING = "edgeproc_import";
const MAGIC = new TextEncoder().encode("SQLite format 3\0");
const HEADER_BYTES = 100;
export function exportDatabase(raw, serializer) {
    const bytes = serializer.serialize(raw);
    if (bytes.byteLength > 0)
        return bytes;
    // A database nobody has written to has no pages yet; give back the file
    // SQLite itself would create for it, so every export is importable.
    const empty = serializer.scratch();
    try {
        empty.exec({ sql: "CREATE TABLE t(x); DROP TABLE t" });
        return serializer.serialize(empty);
    }
    finally {
        empty.close();
    }
}
export function importDatabase(raw, serializer, input, options = {}) {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMPORT_BYTES;
    // `n > NaN` is always false: an unchecked NaN would switch the limit off.
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new RangeError(`maxBytes must be a positive integer; got ${maxBytes}`);
    }
    if (input.byteLength > maxBytes) {
        reject("too-large", `import is ${input.byteLength} bytes; limit ${maxBytes}`);
    }
    // One private copy: the bytes validated are exactly the bytes swapped in.
    const bytes = input.slice();
    assertHeader(bytes);
    const header = validate(serializer, bytes, options);
    swapIn(raw, serializer, bytes);
    return { byteLength: bytes.byteLength, ...header };
}
function reject(reason, message) {
    throw new SqlImportRejectedError(reason, message);
}
/**
 * The magic string only. Truncation and damage are SQLite's call: the file is
 * opened and integrity_check'ed in the scratch connection next.
 */
function assertHeader(bytes) {
    if (bytes.byteLength < HEADER_BYTES ||
        !MAGIC.every((value, index) => bytes[index] === value)) {
        reject("not-sqlite", "import is not a SQLite database");
    }
}
function validate(serializer, bytes, options) {
    const expected = options.expectedSchema ?? {};
    const scratch = serializer.scratch();
    let release;
    try {
        release = serializer.deserialize(scratch, "main", bytes, true);
        scratch.exec({
            sql: "PRAGMA trusted_schema = OFF; PRAGMA query_only = ON",
        });
        const header = readSound(scratch);
        assertExpected(header, expected);
        const rows = objects(scratch, "main");
        const modules = new Set((options.virtualTableModules ?? ["fts5"]).map((m) => m.toLowerCase()));
        assertSafeSchema(serializer, rows, options, modules);
        for (const check of expected.checks ?? [])
            runCheck(scratch, check);
        assertModulesResolve(serializer, bytes, rows, modules);
        return header;
    }
    finally {
        scratch.close();
        release?.();
    }
}
/** integrity_check and the header PRAGMAs; any SQLite error here is corruption. */
function readSound(scratch) {
    try {
        const problems = scratch
            .selectObjects("PRAGMA integrity_check(10)")
            .map((row) => String(row.integrity_check));
        if (problems.length !== 1 || problems[0] !== "ok") {
            reject("corrupt", `import failed integrity_check: ${problems.join("; ")}`);
        }
        return {
            applicationId: Number(scratch.selectObjects("PRAGMA application_id")[0]?.application_id),
            userVersion: Number(scratch.selectObjects("PRAGMA user_version")[0]?.user_version),
        };
    }
    catch (error) {
        if (error instanceof SqlImportRejectedError)
            throw error;
        return reject("corrupt", `import is not readable: ${describe(error)}`);
    }
}
function assertExpected(header, expected) {
    const { applicationId, userVersion } = expected;
    if (applicationId !== undefined && header.applicationId !== applicationId) {
        reject("foreign-application", `import has application_id ${header.applicationId}; expected ${applicationId}`);
    }
    if (userVersion === undefined)
        return;
    const { min, max } = typeof userVersion === "number"
        ? { min: userVersion, max: userVersion }
        : userVersion;
    if ((min !== undefined && header.userVersion < min) ||
        (max !== undefined && header.userVersion > max)) {
        reject("unsupported-version", `import has user_version ${header.userVersion}; supported ${min ?? "*"}..${max ?? "*"}`);
    }
}
// One identifier, exactly as SQLite's grammar spells it: "double", 'single',
// [bracket],
// `backtick` or bare. Bare names are matched greedily so `temp.x` cannot be
// read as `tem`.
const IDENT = "(\"(?:[^\"]|\"\")*\"|'(?:[^']|'')*'|\\[[^\\]]*\\]|`(?:[^`]|``)*`|[A-Za-z_][\\w$]*)(?![\\w$])";
const IF_NOT_EXISTS = "(?:IF\\s+NOT\\s+EXISTS\\s+)?";
const UNQUALIFIED = "(?!\\s*\\.)";
/** The head of each allowed CREATE, anchored; whitespace only, no comments. */
const CREATE_HEAD = {
    table: new RegExp(`^CREATE\\s+TABLE\\s+${IF_NOT_EXISTS}${IDENT}${UNQUALIFIED}`, "i"),
    virtual: new RegExp(`^CREATE\\s+VIRTUAL\\s+TABLE\\s+${IF_NOT_EXISTS}${IDENT}\\s+USING\\s+(\\w+)\\s*(?:\\(|$)`, "i"),
    index: new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+${IF_NOT_EXISTS}${IDENT}${UNQUALIFIED}`, "i"),
    view: new RegExp(`^CREATE\\s+VIEW\\s+${IF_NOT_EXISTS}${IDENT}${UNQUALIFIED}`, "i"),
    trigger: new RegExp(`^CREATE\\s+TRIGGER\\s+${IF_NOT_EXISTS}${IDENT}${UNQUALIFIED}`, "i"),
};
/**
 * Parse the head of one stored CREATE: undefined unless it is the allowed
 * form for its type and names exactly `row.name`, unqualified. For a virtual
 * table, also the module it names (lower case).
 */
export function createHead(row) {
    const match = CREATE_HEAD[isVirtual(row) ? "virtual" : row.type]?.exec(row.sql);
    if (match?.[1] === undefined || unquote(match[1]) !== row.name) {
        return undefined;
    }
    const module = match[2]?.toLowerCase();
    return module === undefined ? {} : { module };
}
function unquote(identifier) {
    const first = identifier[0];
    const inner = identifier.slice(1, -1);
    if (first === '"')
        return inner.replaceAll('""', '"');
    // FTS5 names its shadow tables with 'single quotes'; SQLite accepts that.
    if (first === "'")
        return inner.replaceAll("''", "'");
    if (first === "`")
        return inner.replaceAll("``", "`");
    if (first === "[")
        return inner;
    return identifier;
}
/**
 * The swap re-creates objects from the FILE's schema text, so that text is
 * untrusted input. Every row must be exactly one CREATE of its own kind whose
 * anchored head names this very object, unqualified (no TEMP, no `main.`, no
 * second statement); triggers and views need an explicit opt-in; virtual
 * tables only from listed modules.
 */
function assertSafeSchema(serializer, rows, options, modules) {
    for (const row of rows) {
        if (!isSingleStatement(serializer, row.sql)) {
            reject("corrupt", `import schema row "${row.name}" holds more than one statement`);
        }
        const head = createHead(row);
        if (head === undefined) {
            reject("unsafe-schema", `import schema row "${row.name}" is not a plain, unqualified CREATE ${row.type} of that name`);
        }
        if ((row.type === "trigger" || row.type === "view") &&
            options.allowTriggersAndViews !== true) {
            reject("unsafe-schema", `import contains ${row.type} "${row.name}"; pass allowTriggersAndViews to accept it`);
        }
        const module = head.module;
        if (isVirtual(row) && (module === undefined || !modules.has(module))) {
            reject("unsafe-schema", `import virtual table "${row.name}" uses module ${String(module)}, not in ${[...modules].join(", ")}`);
        }
    }
}
/**
 * Cross-check with SQLite itself, not our parse. In a FRESH connection, drop
 * every module but the allowed ones BEFORE the file is loaded (a virtual
 * table already connected keeps its module), then open each virtual table:
 * SQLite resolves the module from the stored text, and anything not allowed
 * fails with "no such module".
 */
function assertModulesResolve(serializer, bytes, rows, modules) {
    const virtual = rows.filter(isVirtual);
    if (virtual.length === 0)
        return;
    const probe = serializer.scratch();
    let release;
    try {
        serializer.keepOnlyModules(probe, [...modules]);
        release = serializer.deserialize(probe, "main", bytes, true);
        probe.exec({ sql: "PRAGMA trusted_schema = OFF; PRAGMA query_only = ON" });
        for (const row of virtual) {
            try {
                probe.selectObjects(`SELECT * FROM main.${quote(row.name)} LIMIT 0`);
            }
            catch (error) {
                reject("unsafe-schema", `import virtual table "${row.name}" does not open with modules ${[...modules].join(", ")}: ${describe(error)}`);
            }
        }
    }
    finally {
        probe.close();
        release?.();
    }
}
/**
 * SQLite's own tokenizer decides: if any prefix ending at a `;` is already a
 * complete statement, something follows it. Stored schema text never ends in
 * `;`, and a trigger's inner `;`s are incomplete until its END.
 */
function isSingleStatement(serializer, sql) {
    for (let at = sql.indexOf(";"); at !== -1; at = sql.indexOf(";", at + 1)) {
        if (serializer.isComplete(sql.slice(0, at + 1)))
            return false;
    }
    return true;
}
function runCheck(scratch, sql) {
    let value;
    try {
        const row = scratch.selectObjects(sql)[0];
        value = row === undefined ? undefined : Object.values(row)[0];
    }
    catch (error) {
        reject("check-failed", `import check failed (${describe(error)}): ${sql}`);
    }
    if (value !== 1 && value !== 1n) {
        reject("check-failed", `import check did not return 1: ${sql}`);
    }
}
function swapIn(raw, serializer, bytes) {
    raw.exec({ sql: `ATTACH ':memory:' AS ${INCOMING}` });
    let release;
    try {
        // Writable only because BEGIN IMMEDIATE locks every attached schema;
        // nothing writes to it.
        release = serializer.deserialize(raw, INCOMING, bytes, false);
        // Imported views and triggers may only call innocuous functions, now
        // and on every later statement this connection runs.
        raw.exec({ sql: "PRAGMA trusted_schema = OFF" });
        loadIncomingSchema(raw);
        raw.transaction("IMMEDIATE", () => {
            raw.exec({ sql: "PRAGMA defer_foreign_keys = ON" });
            dropMain(raw);
            copyIncoming(raw);
        });
    }
    finally {
        detachIncoming(raw);
        release?.();
    }
}
/**
 * Parse the incoming schema on THIS connection before anything changes. The
 * scratch connection has none of the app's functions, so a schema that only
 * fails here (a STORED generated column calling an app function is "unsafe
 * use" under trusted_schema = OFF) is caught now, as corruption.
 */
function loadIncomingSchema(raw) {
    try {
        raw.selectObjects(`SELECT 1 FROM ${INCOMING}.sqlite_schema LIMIT 1`);
    }
    catch (error) {
        reject("corrupt", `import schema does not load: ${describe(error)}`);
    }
}
/**
 * DETACH must work even when the incoming schema does not parse: every
 * statement re-reads every attached schema, so an unparseable one would
 * leave the live connection broken. writable_schema = ON (SQLite's own
 * "do not report schema errors" switch) holds for this one DETACH only.
 */
function detachIncoming(raw) {
    raw.exec({ sql: "PRAGMA writable_schema = ON" });
    try {
        raw.exec({ sql: `DETACH ${INCOMING}` });
    }
    finally {
        raw.exec({ sql: "PRAGMA writable_schema = OFF" });
    }
}
function objects(raw, schema) {
    return raw
        .selectObjects(
    // Automatic indexes (sql IS NULL) come and go with their tables.
    `SELECT type, name, sql FROM ${schema}.sqlite_schema
			 WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND sql IS NOT NULL
			 ORDER BY rowid`)
        .map((row) => ({
        type: String(row.type),
        name: String(row.name),
        sql: String(row.sql),
    }));
}
const isVirtual = (row) => row.type === "table" && /^CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql);
function dropMain(raw) {
    const before = objects(raw, "main");
    for (const row of before.filter((r) => r.type === "trigger"))
        raw.exec({ sql: `DROP TRIGGER main.${quote(row.name)}` });
    for (const row of before.filter((r) => r.type === "view"))
        raw.exec({ sql: `DROP VIEW main.${quote(row.name)}` });
    // Dropping a virtual table drops its shadow tables, so re-read after.
    for (const row of before.filter(isVirtual))
        raw.exec({ sql: `DROP TABLE main.${quote(row.name)}` });
    for (const row of objects(raw, "main").filter((r) => r.type === "table"))
        raw.exec({ sql: `DROP TABLE main.${quote(row.name)}` });
    if (hasTable(raw, "main", "sqlite_sequence")) {
        raw.exec({ sql: "DELETE FROM main.sqlite_sequence" });
    }
}
function copyIncoming(raw) {
    const incoming = objects(raw, INCOMING);
    // Virtual tables first: creating one creates its shadow tables.
    for (const row of incoming.filter(isVirtual))
        run(raw, row.sql);
    const tables = incoming.filter((r) => r.type === "table" && !isVirtual(r));
    for (const row of tables) {
        if (hasTable(raw, "main", row.name)) {
            raw.exec({ sql: `DELETE FROM main.${quote(row.name)}` });
        }
        else {
            run(raw, row.sql);
        }
        copyRows(raw, row.name);
    }
    if (hasTable(raw, INCOMING, "sqlite_sequence")) {
        // Copying AUTOINCREMENT rows already advanced it; take the file's.
        raw.exec({ sql: "DELETE FROM main.sqlite_sequence" });
        copyRows(raw, "sqlite_sequence");
    }
    // Indexes, views and triggers after the data: no trigger fires on the copy.
    for (const row of incoming) {
        if (row.type !== "table")
            run(raw, row.sql);
    }
    for (const pragma of ["application_id", "user_version"]) {
        const value = Number(raw.selectObjects(`PRAGMA ${INCOMING}.${pragma}`)[0]?.[pragma]);
        raw.exec({ sql: `PRAGMA main.${pragma} = ${Math.trunc(value)}` });
    }
}
/** Copy every stored column, and the rowid where it is not a declared column. */
function copyRows(raw, table) {
    const columns = raw
        .selectObjects("SELECT name, type, pk, hidden FROM pragma_table_xinfo(?, ?)", [table, INCOMING])
        .filter((column) => column.hidden === 0);
    const names = columns.map((column) => String(column.name));
    const listed = names.map(quote);
    const rowid = rowidAlias(raw, table, columns, names);
    if (rowid !== undefined)
        listed.unshift(rowid);
    const list = listed.join(", ");
    raw.exec({
        sql: `INSERT INTO main.${quote(table)} (${list}) SELECT ${list} FROM ${INCOMING}.${quote(table)}`,
    });
}
function rowidAlias(raw, table, columns, names) {
    const withoutRowid = raw.selectObjects("SELECT wr FROM pragma_table_list WHERE schema = ? AND name = ?", [INCOMING, table])[0]?.wr === 1;
    if (withoutRowid)
        return undefined;
    const keys = columns.filter((column) => Number(column.pk) > 0);
    const declaresRowid = keys.length === 1 && String(keys[0]?.type).toUpperCase() === "INTEGER";
    if (declaresRowid)
        return undefined;
    const lower = new Set(names.map((name) => name.toLowerCase()));
    return ["rowid", "oid", "_rowid_"].find((alias) => !lower.has(alias));
}
function hasTable(raw, schema, name) {
    return (raw.selectObjects(`SELECT 1 FROM ${schema}.sqlite_schema WHERE type = 'table' AND name = ?`, [name]).length > 0);
}
/** One statement only: prepare runs the first and ignores any tail. */
function run(raw, sql) {
    const statement = raw.prepare(sql);
    try {
        statement.step();
    }
    finally {
        statement.finalize();
    }
}
function quote(identifier) {
    return `"${identifier.replaceAll('"', '""')}"`;
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=portable.js.map