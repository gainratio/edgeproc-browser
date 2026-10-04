// The vector Worker's side of the protocol, free of Worker globals so it can be
// driven in-process by tests. Requests run strictly one at a time, in order.
import { SqlStorageUnavailableError } from "../../sql/types.js";
import { disposeOwned } from "./poolOwner.js";
export function createVectorWorkerHandler(open) {
    let current;
    let queue = Promise.resolve();
    const dispatch = async (request) => {
        if (request.operation === "initialize") {
            if (current !== undefined) {
                throw new Error("SQLite vector worker is already initialized");
            }
            current = await open(request.options);
            return current.index.capabilities;
        }
        if (current === undefined) {
            throw new Error("SQLite vector worker is not initialized");
        }
        if (request.operation === "dispose") {
            // Answer only once the handles and owner lock are free, so a caller
            // that awaits dispose() can remove or reopen the pool at once.
            const closing = current;
            current = undefined;
            await disposeOwned(closing.index, closing.release);
            return undefined;
        }
        return query(current.index, request);
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
function query(index, request) {
    switch (request.operation) {
        case "insert":
            return index.insert(request.records);
        case "insert-keyed":
            return index.insertKeyed(request.records);
        case "read":
            return index.read(request.recordId);
        case "search":
            return index.search(request.query, request.limit, request.filters);
        case "search-by-ids":
            return index.searchByIds(request.query, request.ids);
        case "lookup-ids":
            return index.lookupIds(request.keys, request.maxDocumentFrequency);
        case "delete":
            return index.delete(request.ids, request.filters);
        case "delete-where":
            return index.deleteWhere(request.filters);
        case "clear":
            return index.clear();
        case "stats":
            return index.stats(request.filters);
        case "runtime-info":
            return index.runtimeInfo();
    }
}
function serializeError(error) {
    return {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof SqlStorageUnavailableError
            ? { reason: error.reason }
            : {}),
    };
}
//# sourceMappingURL=handler.js.map