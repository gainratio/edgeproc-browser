import { OPFS_ASYNC_PROXY_SOURCE } from "./assets/opfsAsyncProxySource.js";
let proxyUrl;
/** Same-origin Blob URL of SQLite's OPFS async proxy, created once per Worker. */
export function inlineOpfsAsyncProxyUrl() {
    proxyUrl ??= URL.createObjectURL(new Blob([OPFS_ASYNC_PROXY_SOURCE], { type: "text/javascript" }));
    return proxyUrl;
}
/**
 * Point sqlite3.mjs at the inline OPFS async proxy. Call before
 * sqlite3InitModule(): the loader consumes globalThis.sqlite3ApiConfig while
 * bootstrapping and deletes it afterwards. Without this the proxy is a
 * network fetch raced against the loader's 4 s timer, and a saturated link
 * loses that race: the VFS is skipped and the durable store cannot open.
 */
export function configureInlineOpfsProxy(scope = globalThis) {
    scope.sqlite3ApiConfig = {
        ...scope.sqlite3ApiConfig,
        opfsProxyUri: inlineOpfsAsyncProxyUrl(),
    };
}
//# sourceMappingURL=opfsAsyncProxy.js.map