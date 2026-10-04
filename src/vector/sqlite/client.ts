import { SqlStorageUnavailableError } from "../../sql/types.js";
import type {
	Metadata,
	VectorHit,
	VectorIndex,
	VectorIndexCapabilities,
	VectorRecord,
	VectorStats,
} from "../types.js";
import type {
	SqliteKeyedVectorRecord,
	SqliteLookupKey,
	SqliteVectorRuntimeInfo,
} from "./database.js";
import type {
	SqliteVectorWorkerFailure,
	SqliteVectorWorkerOptions,
	SqliteVectorWorkerRequest,
	SqliteVectorWorkerResponse,
} from "./protocol.js";

interface WorkerLike {
	postMessage(message: SqliteVectorWorkerRequest): void;
	terminate(): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent<SqliteVectorWorkerResponse>) => void,
	): void;
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
	addEventListener(
		type: "messageerror",
		listener: (event: MessageEvent<unknown>) => void,
	): void;
}

export type SqliteVectorWorkerFactory = () => WorkerLike;

export interface SqliteWorkerVectorIndex extends VectorIndex {
	insertKeyed(records: ReadonlyArray<SqliteKeyedVectorRecord>): Promise<void>;
	lookupIds(
		keys: ReadonlyArray<SqliteLookupKey>,
		maxDocumentFrequency: number,
	): Promise<ReadonlyArray<string>>;
	runtimeInfo(): Promise<SqliteVectorRuntimeInfo>;
}

type Pending = {
	readonly resolve: (value: unknown) => void;
	readonly reject: (reason: Error) => void;
};

type RequestWithoutId = SqliteVectorWorkerRequest extends infer Request
	? Request extends { readonly id: number }
		? Omit<Request, "id">
		: never
	: never;

const PERSISTENT_CAPABILITIES: VectorIndexCapabilities = Object.freeze({
	metrics: Object.freeze(["cosine"] as const),
	exact: true,
	persistent: true,
	metadataFiltering: true,
	scopedDelete: true,
});

/** Worker proxy that keeps synchronous SQLite and OPFS access off the UI thread. */
export class SqliteVectorIndexClient implements SqliteWorkerVectorIndex {
	public readonly name: string;
	public readonly dimension: number;
	public readonly capabilities: VectorIndexCapabilities;
	readonly #worker: WorkerLike;
	readonly #pending = new Map<number, Pending>();
	readonly #ready: Promise<void>;
	#nextId = 1;
	#disposed = false;
	#terminalError: Error | undefined;

	public constructor(
		options: SqliteVectorWorkerOptions,
		workerFactory: SqliteVectorWorkerFactory = defaultWorkerFactory,
	) {
		this.name = options.name;
		this.dimension = options.dimension;
		this.capabilities = Object.freeze({
			...PERSISTENT_CAPABILITIES,
			persistent: (options.persistence ?? "opfs") === "opfs",
		});
		this.#worker = workerFactory();
		this.#worker.addEventListener("message", (event) => {
			this.#receive(event.data);
		});
		this.#worker.addEventListener("error", (event) => {
			this.#failTerminal(
				new Error(`SQLite vector worker failed: ${event.message}`),
			);
		});
		this.#worker.addEventListener("messageerror", () => {
			this.#failTerminal(
				new Error("SQLite vector worker returned an unreadable message"),
			);
		});
		this.#ready = this.#request({ operation: "initialize", options })
			.then(() => undefined)
			.catch((reason: unknown) => {
				const error =
					reason instanceof Error ? reason : new Error(String(reason));
				this.#failTerminal(error);
				throw error;
			});
	}

	public ready(): Promise<void> {
		return this.#ready;
	}

	public async insert(records: ReadonlyArray<VectorRecord>): Promise<void> {
		await this.#ready;
		await this.#request({ operation: "insert", records });
	}

	public async insertKeyed(
		records: ReadonlyArray<SqliteKeyedVectorRecord>,
	): Promise<void> {
		await this.#ready;
		await this.#request({ operation: "insert-keyed", records });
	}

	public async read(id: string): Promise<VectorRecord | undefined> {
		await this.#ready;
		return (await this.#request({
			operation: "read",
			recordId: id,
		})) as VectorRecord | undefined;
	}

	public async search(
		query: Float32Array,
		limit: number,
		filters?: Metadata,
	): Promise<ReadonlyArray<VectorHit>> {
		await this.#ready;
		return (await this.#request({
			operation: "search",
			query,
			limit,
			...(filters === undefined ? {} : { filters }),
		})) as ReadonlyArray<VectorHit>;
	}

	public async searchByIds(
		query: Float32Array,
		ids: ReadonlyArray<string>,
	): Promise<ReadonlyArray<VectorHit>> {
		await this.#ready;
		return (await this.#request({
			operation: "search-by-ids",
			query,
			ids,
		})) as ReadonlyArray<VectorHit>;
	}

	public async lookupIds(
		keys: ReadonlyArray<SqliteLookupKey>,
		maxDocumentFrequency: number,
	): Promise<ReadonlyArray<string>> {
		await this.#ready;
		return (await this.#request({
			operation: "lookup-ids",
			keys,
			maxDocumentFrequency,
		})) as ReadonlyArray<string>;
	}

	public async delete(
		ids: ReadonlyArray<string>,
		filters?: Metadata,
	): Promise<number> {
		await this.#ready;
		return (await this.#request({
			operation: "delete",
			ids,
			...(filters === undefined ? {} : { filters }),
		})) as number;
	}

	public async deleteWhere(filters: Metadata): Promise<number> {
		await this.#ready;
		return (await this.#request({
			operation: "delete-where",
			filters,
		})) as number;
	}

	public async clear(): Promise<number> {
		await this.#ready;
		return (await this.#request({ operation: "clear" })) as number;
	}

	public async stats(filters?: Metadata): Promise<VectorStats> {
		await this.#ready;
		return (await this.#request({
			operation: "stats",
			...(filters === undefined ? {} : { filters }),
		})) as VectorStats;
	}

	public async runtimeInfo(): Promise<SqliteVectorRuntimeInfo> {
		await this.#ready;
		return (await this.#request({
			operation: "runtime-info",
		})) as SqliteVectorRuntimeInfo;
	}

	public async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		this.#disposed = true;
		try {
			await this.#ready;
			await this.#request({ operation: "dispose" }, true);
		} finally {
			this.#worker.terminate();
			this.#failAll(new Error("SQLite vector index is disposed"));
		}
	}

	#request(request: RequestWithoutId, allowDisposed = false): Promise<unknown> {
		if (this.#disposed && !allowDisposed) {
			return Promise.reject(new Error("SQLite vector index is disposed"));
		}
		if (this.#terminalError !== undefined) {
			return Promise.reject(this.#terminalError);
		}
		const id = this.#nextId;
		this.#nextId += 1;
		return new Promise((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#worker.postMessage({ ...request, id } as SqliteVectorWorkerRequest);
		});
	}

	#receive(response: SqliteVectorWorkerResponse): void {
		const pending = this.#pending.get(response.id);
		if (pending === undefined) {
			return;
		}
		this.#pending.delete(response.id);
		if (response.ok) {
			pending.resolve(response.value);
		} else {
			pending.reject(reconstructError(response.error));
		}
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			pending.reject(error);
		}
		this.#pending.clear();
	}

	#failTerminal(error: Error): void {
		this.#terminalError = error;
		this.#worker.terminate();
		this.#failAll(error);
	}
}

/** Rebuild the typed refusal the Worker sent; anything else stays a named Error. */
function reconstructError(error: SqliteVectorWorkerFailure["error"]): Error {
	if (
		error.name === "SqlStorageUnavailableError" &&
		error.reason !== undefined
	) {
		return new SqlStorageUnavailableError(error.reason, error.message);
	}
	const rebuilt = new Error(error.message);
	rebuilt.name = error.name;
	return rebuilt;
}

export async function createSqliteVectorIndex(
	options: SqliteVectorWorkerOptions,
): Promise<SqliteWorkerVectorIndex> {
	const index = new SqliteVectorIndexClient(options);
	await index.ready();
	return index;
}

function defaultWorkerFactory(): WorkerLike {
	return new Worker(new URL("./worker.js", import.meta.url), {
		type: "module",
		name: "edgeproc-sqlite-vector",
	});
}
