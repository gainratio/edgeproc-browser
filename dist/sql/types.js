/** OPFS could not be used and no fallback was allowed. */
export class SqlStorageUnavailableError extends Error {
    reason;
    constructor(reason, message) {
        super(message);
        this.name = "SqlStorageUnavailableError";
        this.reason = reason;
    }
}
//# sourceMappingURL=types.js.map