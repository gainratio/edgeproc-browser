import type { LegacySource } from "./migration.js";
export interface IndexedDbLayout {
    readonly database: string;
    readonly store: string;
    readonly separator: ":" | "/";
}
export type IndexedDbLayoutOptions = Partial<IndexedDbLayout>;
export declare function resolveIndexedDbLayout(options?: IndexedDbLayoutOptions, defaultDatabase?: string): IndexedDbLayout;
export declare function indexedDbLegacySource(layout: IndexedDbLayout, factory?: IDBFactory): LegacySource;
/** @internal Resolves on commit; an error or abort (an error always aborts)
 * rejects, so a delete that did not land is never reported as done. */
export declare function transactionDone(tx: Pick<IDBTransaction, "oncomplete" | "onabort" | "error">): Promise<void>;
/** @internal */
export declare function settle<T>(request: Pick<IDBRequest<T>, "onsuccess" | "onerror" | "result" | "error">): Promise<T>;
/** The slice of an OPFS directory handle the legacy reader needs. */
export interface LegacyDirectory {
    getDirectoryHandle(name: string): Promise<LegacyDirectory>;
    getFileHandle(name: string): Promise<{
        getFile(): Promise<Blob>;
    }>;
    keys(): AsyncIterableIterator<string>;
    removeEntry(name: string, options?: {
        recursive?: boolean;
    }): Promise<void>;
}
export declare function opfsLegacySource(root?: () => Promise<LegacyDirectory>): LegacySource;
//# sourceMappingURL=legacyStores.d.ts.map