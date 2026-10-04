import type { SqlFallbackReason } from "../../sql/types.js";
import type { MemoryProfileSetting } from "../../sqlite/memoryProfile.js";
import type { Metadata, VectorIndexOptions, VectorRecord } from "../types.js";
import type {
	SqliteKeyedVectorRecord,
	SqliteLookupKey,
	SqliteVectorRuntimeInfo,
} from "./database.js";

export type SqliteVectorPersistence = "memory" | "opfs";

export interface SqliteVectorWorkerOptions extends VectorIndexOptions {
	readonly persistence?: SqliteVectorPersistence;
	/** SQLite page cache and heap limits. Default "auto": sized to the device, conservative on iOS. */
	readonly memoryProfile?: MemoryProfileSetting;
}

export type SqliteVectorWorkerRequest =
	| {
			readonly id: number;
			readonly operation: "initialize";
			readonly options: SqliteVectorWorkerOptions;
	  }
	| {
			readonly id: number;
			readonly operation: "insert";
			readonly records: ReadonlyArray<VectorRecord>;
	  }
	| {
			readonly id: number;
			readonly operation: "insert-keyed";
			readonly records: ReadonlyArray<SqliteKeyedVectorRecord>;
	  }
	| {
			readonly id: number;
			readonly operation: "read";
			readonly recordId: string;
	  }
	| {
			readonly id: number;
			readonly operation: "search";
			readonly query: Float32Array;
			readonly limit: number;
			readonly filters?: Metadata;
	  }
	| {
			readonly id: number;
			readonly operation: "search-by-ids";
			readonly query: Float32Array;
			readonly ids: ReadonlyArray<string>;
	  }
	| {
			readonly id: number;
			readonly operation: "lookup-ids";
			readonly keys: ReadonlyArray<SqliteLookupKey>;
			readonly maxDocumentFrequency: number;
	  }
	| {
			readonly id: number;
			readonly operation: "delete";
			readonly ids: ReadonlyArray<string>;
			readonly filters?: Metadata;
	  }
	| {
			readonly id: number;
			readonly operation: "delete-where";
			readonly filters: Metadata;
	  }
	| { readonly id: number; readonly operation: "clear" }
	| {
			readonly id: number;
			readonly operation: "stats";
			readonly filters?: Metadata;
	  }
	| { readonly id: number; readonly operation: "runtime-info" }
	| { readonly id: number; readonly operation: "dispose" };

export type SqliteVectorWorkerSuccess = {
	readonly id: number;
	readonly ok: true;
	readonly value: unknown;
};

export interface SqliteVectorWorkerFailure {
	readonly id: number;
	readonly ok: false;
	readonly error: {
		readonly name: string;
		readonly message: string;
		/** Set for SqlStorageUnavailableError, so the client can rebuild the type. */
		readonly reason?: SqlFallbackReason;
	};
}

export type SqliteVectorWorkerResponse =
	| SqliteVectorWorkerSuccess
	| SqliteVectorWorkerFailure;

export interface SqliteVectorIndexRuntime {
	runtimeInfo(): Promise<SqliteVectorRuntimeInfo>;
}
