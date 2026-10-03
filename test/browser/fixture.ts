import {
	createSqliteStateStore,
	type SqliteStateRuntimeInfo,
} from "@gainratio/browser/sqlite";
import {
	createSqliteVectorIndex,
	type SqliteVectorRuntimeInfo,
} from "@gainratio/browser/vector/sqlite";

export interface BrowserProof {
	readonly runtime: SqliteVectorRuntimeInfo;
	readonly firstNearest: string | undefined;
	readonly namedIds: ReadonlyArray<string>;
	readonly keyedIds: ReadonlyArray<string>;
	readonly deletedWhere: number;
	readonly reopenedNearest: string | undefined;
	readonly reopenedCount: number;
	readonly cleared: number;
}

export interface StateBrowserProof {
	readonly crossOriginIsolated: boolean;
	readonly runtime: SqliteStateRuntimeInfo;
	readonly sqliteHeader: string;
	readonly stagedRows: number;
	readonly beforeCommit: number | undefined;
	readonly restored: ReadonlyArray<number>;
	readonly sharedRead: ReadonlyArray<number>;
	readonly staleCas: string;
	readonly concurrentCas: ReadonlyArray<string>;
	readonly reopened: ReadonlyArray<number>;
	readonly resetCount: number;
}

import type {
	OpfsInstallProbe,
	OpfsInstallResult,
} from "./opfs-install-worker.js";

export interface OpfsOpenProof {
	readonly persistence: string;
	readonly error: string | undefined;
	readonly elapsedMs: number;
}

declare global {
	interface Window {
		runSqliteVectorProof(name: string): Promise<BrowserProof>;
		runSqliteStateProof(name: string): Promise<StateBrowserProof>;
		runSqliteOpfsOpenProof(name: string): Promise<OpfsOpenProof>;
		runOpfsInstallProbe(probe: OpfsInstallProbe): Promise<OpfsInstallResult>;
		seedSqliteState(name: string, rows: number): Promise<number>;
		runSqliteStateTabTraffic(
			name: string,
			tab: string,
			rounds: number,
		): Promise<TabTrafficProof>;
	}
}

export interface TabTrafficProof {
	readonly failures: ReadonlyArray<string>;
	readonly ownRows: number;
}

/** Grow the durable store so whole-file reads take a noticeable time. */
window.seedSqliteState = async (name, rows): Promise<number> => {
	const store = await createSqliteStateStore({
		name,
		initialSchemaVersion: 1,
		persistence: "opfs",
	});
	const value = new Uint8Array(64 * 1024).fill(7);
	for (let start = 0; start < rows; start += 100) {
		const mutations = [];
		for (let row = start; row < Math.min(rows, start + 100); row += 1) {
			mutations.push({
				type: "put" as const,
				namespace: "seed",
				key: `row-${row}`,
				value,
			});
		}
		await store.batch(mutations);
	}
	const count = (await store.runtimeInfo()).rowCount;
	await store.dispose();
	return count;
};

/**
 * One tab's share of a two-tab workload: open the durable store, then
 * interleave reads and writes against it. Run in two pages at once, this is
 * the "same app open in two tabs" case: two Workers, two OPFS async proxies,
 * one database file.
 */
window.runSqliteStateTabTraffic = async (
	name,
	tab,
	rounds,
): Promise<TabTrafficProof> => {
	const failures: string[] = [];
	const describe = (reason: unknown): string =>
		reason instanceof Error
			? `${reason.name}: ${reason.message}`
			: String(reason);
	let store: Awaited<ReturnType<typeof createSqliteStateStore>>;
	try {
		store = await createSqliteStateStore({
			name,
			initialSchemaVersion: 1,
			persistence: "opfs",
		});
	} catch (error) {
		return { failures: [`open: ${describe(error)}`], ownRows: 0 };
	}
	for (let round = 0; round < rounds; round += 1) {
		// Pipeline a burst so this tab's Worker queue never idles: a busy
		// neighbour is what keeps an OPFS sync access handle held.
		const operations: Promise<unknown>[] = [
			store.put("traffic", `${tab}-${round}`, new Uint8Array(64 * 1024)),
			store.list({ namespace: "traffic", limit: 50 }),
		];
		for (let read = 0; read < 100; read += 1) {
			operations.push(store.get("traffic", `${tab}-${round}`));
		}
		// A backup and an integrity check read the whole file under one
		// shared lock, the longest a tab holds the file's sync access handle.
		operations.push(store.exportBytes(), store.checkIntegrity());
		for (const outcome of await Promise.allSettled(operations)) {
			if (outcome.status === "rejected")
				failures.push(describe(outcome.reason));
		}
	}
	let ownRows = 0;
	for (let round = 0; round < rounds; round += 1) {
		if ((await store.get("traffic", `${tab}-${round}`)) !== undefined) {
			ownRows += 1;
		}
	}
	await store.dispose();
	return { failures, ownRows };
};

/** Run sqlite3.mjs once in a fresh Worker with a doctored async proxy. */
window.runOpfsInstallProbe = (probe): Promise<OpfsInstallResult> =>
	new Promise((resolve, reject) => {
		const worker = new Worker(
			new URL("./opfs-install-worker.ts", import.meta.url),
			{ type: "module" },
		);
		worker.addEventListener(
			"message",
			(event: MessageEvent<OpfsInstallResult>) => {
				worker.terminate();
				resolve(event.data);
			},
		);
		worker.addEventListener("error", (event) => {
			worker.terminate();
			reject(new Error(event.message));
		});
		worker.postMessage(probe);
	});

/** Open the durable (OPFS) state store once and report how that went. */
window.runSqliteOpfsOpenProof = async (name): Promise<OpfsOpenProof> => {
	const started = performance.now();
	const elapsed = () => Math.round(performance.now() - started);
	try {
		const store = await createSqliteStateStore({
			name,
			initialSchemaVersion: 1,
			persistence: "opfs",
		});
		const info = await store.runtimeInfo();
		await store.dispose();
		return {
			persistence: info.persistence,
			error: undefined,
			elapsedMs: elapsed(),
		};
	} catch (error) {
		return {
			persistence: "failed",
			error: error instanceof Error ? error.message : String(error),
			elapsedMs: elapsed(),
		};
	}
};

window.runSqliteVectorProof = async (name): Promise<BrowserProof> => {
	const first = await createSqliteVectorIndex({
		name,
		dimension: 3,
		persistence: "opfs",
	});
	const runtime = await first.runtimeInfo();
	await first.insert([
		{
			id: "closest",
			vector: new Float32Array([1, 0, 0]),
			metadata: { tenant: "browser", active: true },
		},
		{
			id: "far",
			vector: new Float32Array([0, 1, 0]),
			metadata: { tenant: "browser", active: false },
		},
	]);
	await first.insertKeyed([
		{
			id: "keyed",
			vector: new Float32Array([0, 0, 1]),
			metadata: { tenant: "browser", active: true },
			lookupKeys: [{ namespace: "token", value: "portable" }],
		},
	]);
	const firstNearest = (
		await first.search(new Float32Array([0.9, 0.1, 0]), 1, {
			tenant: "browser",
			active: true,
		})
	)[0]?.id;
	const namedIds = (
		await first.searchByIds(new Float32Array([0.9, 0.1, 0]), [
			"far",
			"closest",
			"missing",
			"closest",
		])
	).map(({ id }) => id);
	const keyedIds = await first.lookupIds(
		[{ namespace: "token", value: "portable" }],
		1,
	);
	const deletedWhere = await first.deleteWhere({ active: false });
	await first.dispose();

	const reopened = await createSqliteVectorIndex({
		name,
		dimension: 3,
		persistence: "opfs",
	});
	const reopenedNearest = (
		await reopened.search(new Float32Array([0.9, 0.1, 0]), 1)
	)[0]?.id;
	const reopenedCount = (await reopened.stats()).vectorCount;
	const cleared = await reopened.clear();
	const remaining = await reopened.stats();
	await reopened.dispose();

	if (remaining.vectorCount !== 0) {
		throw new Error("clear left persistent vectors behind");
	}
	return {
		runtime,
		firstNearest,
		namedIds,
		keyedIds,
		deletedWhere,
		reopenedNearest,
		reopenedCount,
		cleared,
	};
};

window.runSqliteStateProof = async (name): Promise<StateBrowserProof> => {
	const first = await createSqliteStateStore({
		name,
		initialSchemaVersion: 3,
		persistence: "opfs",
	});
	await first.batch([
		{
			type: "put",
			namespace: "chat",
			key: "thread-1",
			value: new Uint8Array([1, 2, 3]),
		},
		{
			type: "put",
			namespace: "profile",
			key: "primary",
			value: new Uint8Array([4, 5]),
		},
	]);
	const runtime = await first.runtimeInfo();
	const exported = await first.exportBytes();
	const sqliteHeader = new TextDecoder().decode(exported.slice(0, 16));
	await first.put("chat", "thread-1", new Uint8Array([9]));
	const staged = await first.stageImport(exported);
	const beforeCommit = (await first.get("chat", "thread-1"))?.value[0];
	await first.commitImport(staged.stageId, { expectedEpoch: 2 });
	const restored = [...((await first.get("chat", "thread-1"))?.value ?? [])];

	const second = await createSqliteStateStore({
		name,
		initialSchemaVersion: 3,
		persistence: "opfs",
	});
	const sharedRead = [...((await second.get("chat", "thread-1"))?.value ?? [])];
	await second.put("profile", "primary", new Uint8Array([6, 7]), {
		expectedEpoch: 3,
	});
	let staleCas = "";
	try {
		await first.put("profile", "primary", new Uint8Array([8]), {
			expectedEpoch: 3,
		});
	} catch (error) {
		staleCas = error instanceof Error ? error.name : String(error);
	}
	const concurrentCas = await Promise.all(
		[
			first.put("race", "first", new Uint8Array([1]), { expectedEpoch: 4 }),
			second.put("race", "second", new Uint8Array([2]), { expectedEpoch: 4 }),
		].map((operation) =>
			operation.then(
				() => "committed",
				(error: unknown) =>
					error instanceof Error ? error.name : String(error),
			),
		),
	);
	await first.dispose();
	await second.dispose();

	const reopenedStore = await createSqliteStateStore({
		name,
		initialSchemaVersion: 99,
		persistence: "opfs",
	});
	const reopened = [
		...((await reopenedStore.get("profile", "primary"))?.value ?? []),
	];
	const resetCount = (await reopenedStore.reset()).changed;
	await reopenedStore.dispose();
	return {
		crossOriginIsolated,
		runtime,
		sqliteHeader,
		stagedRows: staged.rowCount,
		beforeCommit,
		restored,
		sharedRead,
		staleCas,
		concurrentCas,
		reopened,
		resetCount,
	};
};
