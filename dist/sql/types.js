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
//# sourceMappingURL=types.js.map