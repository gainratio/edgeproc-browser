/** The config object sqlite3.mjs reads once, during bootstrap (upstream hook). */
export interface Sqlite3ApiConfigScope {
    sqlite3ApiConfig?: Record<string, unknown>;
}
/** Same-origin Blob URL of SQLite's OPFS async proxy, created once per Worker. */
export declare function inlineOpfsAsyncProxyUrl(): string;
/**
 * Point sqlite3.mjs at the inline OPFS async proxy. Call before
 * sqlite3InitModule(): the loader consumes globalThis.sqlite3ApiConfig while
 * bootstrapping and deletes it afterwards. Without this the proxy is a
 * network fetch raced against the loader's 4 s timer, and a saturated link
 * loses that race: the VFS is skipped and the durable store cannot open.
 */
export declare function configureInlineOpfsProxy(scope?: Sqlite3ApiConfigScope): void;
//# sourceMappingURL=opfsAsyncProxy.d.ts.map