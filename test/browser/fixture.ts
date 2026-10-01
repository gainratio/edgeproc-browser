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

declare global {
	interface Window {
		runSqliteVectorProof(name: string): Promise<BrowserProof>;
		runSqliteStateProof(name: string): Promise<StateBrowserProof>;
	}
}

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
