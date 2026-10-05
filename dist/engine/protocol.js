// Typed postMessage envelopes between the main thread and the Worker. The Worker
// owns the SQLite chunk database + the sync engine; the main thread only sends requests + awaits
// replies. Discriminated unions on `kind` / `ok` keep the bridge type-safe.
export {};
//# sourceMappingURL=protocol.js.map