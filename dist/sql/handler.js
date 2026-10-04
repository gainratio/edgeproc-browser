// The Worker side of the protocol, free of Worker globals so it can be driven
// in-process by tests. Requests run strictly one at a time, in arrival order.
import { SqlImportRejectedError, SqlStorageUnavailableError, } from "./types.js";
export function createSqlWorkerHandler(open) {
    let current;
    let queue = Promise.resolve();
    const dispatch = async (request) => {
        if (request.operation === "open") {
            if (current !== undefined) {
                throw new Error("SQL worker already has an open database");
            }
            current = await open(request.options);
            return current.engine.runtimeInfo().storage;
        }
        if (current === undefined)
            throw new Error("SQL worker has no open database");
        const { engine } = current;
        switch (request.operation) {
            case "exec":
                return engine.exec(request.sql, request.bind);
            case "query":
                return engine.query(request.sql, request.bind);
            case "transaction":
                return engine.transaction(request.statements);
            case "execute-many":
                return engine.executeMany(request.sql, request.rows);
            case "prepare":
                return engine.prepare(request.sql);
            case "run-prepared":
                return engine.runPrepared(request.statement, request.bind);
            case "all-prepared":
                return engine.allPrepared(request.statement, request.bind);
            case "finalize":
                return engine.finalize(request.statement);
            case "export":
                return engine.exportDatabase();
            case "import":
                return engine.importDatabase(request.bytes, request.options);
            case "runtime-info":
                return engine.runtimeInfo();
            case "close": {
                const closing = current;
                current = undefined;
                try {
                    closing.engine.close();
                }
                finally {
                    closing.release();
                }
                return undefined;
            }
        }
    };
    return (request) => {
        const result = queue.then(async () => {
            try {
                return { id: request.id, ok: true, value: await dispatch(request) };
            }
            catch (error) {
                return { id: request.id, ok: false, error: serializeError(error) };
            }
        });
        queue = result;
        return result;
    };
}
function serializeError(error) {
    if (error instanceof SqlStorageUnavailableError) {
        return { name: error.name, message: error.message, reason: error.reason };
    }
    if (error instanceof SqlImportRejectedError) {
        return {
            name: error.name,
            message: error.message,
            rejection: error.reason,
        };
    }
    return {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
    };
}
//# sourceMappingURL=handler.js.map