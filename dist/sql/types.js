/** OPFS could not be used and no fallback was allowed. */
export class SqlStorageUnavailableError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.name = "SqlStorageUnavailableError";
        this.reason = reason;
    }
}
/** The incoming file was refused during validation; your database is unchanged. */
export class SqlImportRejectedError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.name = "SqlImportRejectedError";
        this.reason = reason;
    }
}
/**
 * SQLite ended the interactive transaction itself (a RAISE(ROLLBACK), or an
 * error such as SQLITE_FULL, IOERR or BUSY that rolls the whole transaction
 * back). Its writes are gone, and nothing more runs in it.
 */
export class SqlTransactionEndedError extends Error {
    constructor(message = "the SQL transaction already ended; its writes were rolled back") {
        super(message);
        this.name = "SqlTransactionEndedError";
    }
}
//# sourceMappingURL=types.js.map