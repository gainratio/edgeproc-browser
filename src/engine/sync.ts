// Signed-bundle sync state machine. Every attacker-controlled dimension is
// bounded before allocation/fetch, and promotion remains the final operation.

import { optionalExpiry, optionalKeyId } from "./activePointer.js";
import { canonicalBytes, type JsonValue } from "./canonical.js";
import { sha256Hex } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError, MAX_DECOMPRESSED_CHUNK_BYTES } from "./integrity.js";
import { assertKeyring, type Keyring, verifyWithKeyring } from "./keyring.js";
import { isQuotaError } from "./storageError.js";
import type {
	CacheStore,
	ChunkRef,
	CompressedChunk,
	FetchBytes,
	FetchBytesOptions,
	FileEntry,
	IndexManifest,
	SyncResult,
	Verify,
	VersionPointer,
} from "./types.js";

export type SyncProgress =
	| { readonly phase: "pointer"; readonly version: string }
	| {
			readonly phase: "manifest";
			readonly totalFiles: number;
			readonly selectedFiles: number;
	  }
	| {
			/** Reported on every network read (rate-limited) and on every
			 * verified chunk, so a consumer can draw a real progress bar and an
			 * idle timer can tell "slow" from "stalled". */
			readonly phase: "chunks";
			/** Chunks fetched, verified and stored so far. */
			readonly fetchedChunks: number;
			/** Chunks this sync has to fetch (missing from the cache). */
			readonly totalChunks: number;
			/** Compressed (on-the-wire) bytes of the completed chunks. */
			readonly bytesFetched: number;
			/** Uncompressed bytes of every chunk this sync fetches: exact, from
			 * the signed manifest, known before the first byte arrives. */
			readonly bytesTotal: number;
			/** Uncompressed-byte progress: completed chunks plus the received
			 * fraction of in-flight ones. Reaches `bytesTotal` exactly. */
			readonly bytesDone: number;
	  }
	| {
			/** One chunk fetch failed as a network outage or stall and is being
			 * retried after `delayMs`. Bytes already verified are kept. */
			readonly phase: "chunkRetry";
			readonly hash: string;
			/** Attempts made so far (1 = the first attempt just failed). */
			readonly attempt: number;
			readonly maxAttempts: number;
			readonly delayMs: number;
			readonly reason: string;
	  }
	| {
			/** Every chunk is in; files are being reassembled and checked
			 * against their signed hashes. */
			readonly phase: "verify";
			readonly verifiedFiles: number;
			readonly totalFiles: number;
	  }
	| { readonly phase: "promoted"; readonly result: SyncResult };

export interface SyncArgs {
	readonly baseUrl: string;
	readonly store: CacheStore;
	readonly fetchBytes: FetchBytes;
	/** Single-verifier seam: authoritative for every signature. A pointer's
	 * `key_id` is covered by the signature but cannot select a key here; use
	 * {@link KeyringSyncArgs} for key selection and revocation. */
	readonly verify: Verify;
	/** Mutually exclusive with `verify`; see {@link KeyringSyncArgs}. */
	readonly keyring?: never;
	/** Clock for `expires_at`, in Unix SECONDS (fractions allowed). Defaults to
	 * `Date.now() / 1000`. Read only for pointers that carry `expires_at`; a
	 * non-finite reading fails closed with a TypeError. */
	readonly now?: () => number;
	/** undefined skips the check; null requires a legacy absent/null identity. */
	readonly expectedBundleId?: string | null;
	/** undefined skips the check; null requires a legacy absent/null channel. */
	readonly expectedChannel?: string | null;
	/** undefined fetches all file chunks; [] authenticates/promotes the catalog only. */
	readonly wantedPaths?: ReadonlyArray<string>;
	/** Observer only: exceptions are isolated from the integrity state machine. */
	readonly onProgress?: (progress: SyncProgress) => void;
	/** Test seam for bounded per-chunk network retry backoff. */
	readonly sleep?: (milliseconds: number) => Promise<void>;
	/** Tests/operators may only LOWER the aggregate cap, never raise the release
	 * ceiling. This keeps failure paths cheap to exercise without weakening prod. */
	readonly limits?: { readonly maxTotalFetchBytes?: number };
}

const DECODER = new TextDecoder();
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_POINTER_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPRESSED_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_FETCH_BYTES = 256 * 1024 * 1024;
// The signed bundle now ships one license-clean product image (images/<id>.svg)
// per catalog product alongside the core index files, so a 720-product demo
// carries ~728 files. This cap gives bounded headroom over that while remaining
// a real DoS guard; aggregate byte/chunk ceilings below still bound total work.
const MAX_SYNC_FILES = 1024;
const MAX_CHUNK_REFS = 8192;
const MAX_DISTINCT_CHUNKS = 4096;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_CONCURRENT_CHUNK_FETCHES = 8;
const CHUNK_FETCH_ATTEMPTS = 6;
const CHUNK_RETRY_BASE_DELAY_MS = 250;
/** Byte-level progress is rate-limited to this interval; chunk completions
 * and retries are always reported. */
const PROGRESS_INTERVAL_MS = 250;

/** Fetched chunks are handed to a batch-capable store in groups of at most
 * this many chunks or bytes. Each batch is one storage write (one OPFS pack
 * file) instead of one per chunk; the bound also caps how many fetched bytes
 * wait in memory before landing. */
export const MAX_STORE_BATCH_CHUNKS = 128;
export const MAX_STORE_BATCH_BYTES = 4 * 1024 * 1024;

/** Maximum silent backoff before one chunk fetch is declared unreachable. */
export const MAX_CHUNK_RETRY_BUDGET_MS =
	CHUNK_RETRY_BASE_DELAY_MS * (2 ** (CHUNK_FETCH_ATTEMPTS - 1) - 1) +
	CHUNK_RETRY_BASE_DELAY_MS * (CHUNK_FETCH_ATTEMPTS - 1);

/** Sync verified under a trust-root keyring instead of a single verifier:
 * `key_id` selects the key, revoked keys never verify, and an unknown key
 * fails closed. Exactly one of `verify` / `keyring` must be supplied. */
export interface KeyringSyncArgs extends Omit<SyncArgs, "verify" | "keyring"> {
	readonly keyring: Keyring;
	readonly verify?: never;
}

/** Verifies a pointer's detached signature, or throws a SignatureError. */
type PointerAuthenticator = (pointer: VersionPointer) => Promise<void>;

const realSleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

export class SyncCapError extends IntegrityError {
	public constructor(message: string) {
		super(message);
		this.name = "SyncCapError";
	}
}

export class RollbackError extends IntegrityError {
	public constructor(message: string) {
		super(message);
		this.name = "RollbackError";
	}
}

/** A validly signed network pointer is at or past its signed `expires_at`:
 * the publisher no longer vouches that it is current (a freeze/replay). */
export class PointerExpiredError extends IntegrityError {
	public constructor(message = "signed latest pointer has expired") {
		super(message);
		this.name = "PointerExpiredError";
	}
}

function parseJson(bytes: Uint8Array, label: string): unknown {
	try {
		return JSON.parse(DECODER.decode(bytes)) as unknown;
	} catch (cause) {
		throw new IntegrityError(`${label} is not valid JSON`, { cause });
	}
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new IntegrityError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertHash(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !SHA256.test(value)) {
		throw new IntegrityError(`${label} must be a lowercase SHA-256 digest`);
	}
}

function assertBoundedInteger(
	value: unknown,
	label: string,
	maximum: number,
): asserts value is number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw new IntegrityError(`${label} must be a non-negative safe integer`);
	}
	if ((value as number) > maximum) {
		throw new SyncCapError(`${label} exceeds ${maximum}-byte cap`);
	}
}

function assertVersionPointer(
	value: unknown,
	requireSequence = true,
): asserts value is VersionPointer {
	const pointer = objectAt(value, "signed latest pointer");
	assertHash(pointer.manifest_hash, "pointer manifest_hash");
	if (
		typeof pointer.version !== "string" ||
		pointer.version.length === 0 ||
		pointer.version.length > 200 ||
		typeof pointer.signature !== "string" ||
		pointer.signature.length === 0 ||
		pointer.signature.length > 512
	) {
		throw new IntegrityError(
			"signed latest pointer has invalid version/signature",
		);
	}
	const validSequence =
		Number.isSafeInteger(pointer.sequence) && (pointer.sequence as number) >= 0;
	if (
		(requireSequence && !validSequence) ||
		(!requireSequence &&
			pointer.sequence !== undefined &&
			pointer.sequence !== null &&
			!validSequence)
	) {
		throw new IntegrityError(
			"signed latest pointer is missing a non-negative monotonic sequence",
		);
	}
	if (!optionalKeyId(pointer.key_id)) {
		throw new IntegrityError(
			"pointer key_id must be 16 lowercase hex characters or null",
		);
	}
	if (!optionalExpiry(pointer.expires_at)) {
		throw new IntegrityError(
			"pointer expires_at must be a positive safe integer (Unix seconds) or null",
		);
	}
	for (const field of ["bundle_id", "channel"] as const) {
		const item = pointer[field];
		if (
			item !== undefined &&
			item !== null &&
			(typeof item !== "string" || item.length > 200)
		) {
			throw new IntegrityError(
				`pointer ${field} must be a string of at most 200 characters or null`,
			);
		}
	}
}

/** The exact bytes a pointer's signature covers: canonical JSON without
 * `signature`, and without any optional field that is null or absent — so a
 * pointer that predates an optional field keeps its original preimage. */
export function pointerSigningBytes(pointer: VersionPointer): Uint8Array {
	return canonicalBytes(pointer as unknown as JsonValue, {
		exclude: {
			signature: true,
			...(pointer.bundle_id == null ? { bundle_id: true as const } : {}),
			...(pointer.channel == null ? { channel: true as const } : {}),
			...(pointer.key_id == null ? { key_id: true as const } : {}),
			...(pointer.expires_at == null ? { expires_at: true as const } : {}),
		},
	});
}

async function pointerAuthenticator(
	args: SyncArgs | KeyringSyncArgs,
): Promise<PointerAuthenticator> {
	const { verify, keyring } = args as {
		readonly verify?: Verify;
		readonly keyring?: Keyring;
	};
	if ((verify === undefined) === (keyring === undefined)) {
		throw new TypeError("syncIndex needs exactly one of verify or keyring");
	}
	if (keyring !== undefined) {
		await assertKeyring(keyring);
		return (pointer) =>
			verifyWithKeyring(
				keyring,
				pointerSigningBytes(pointer),
				pointer.signature,
				pointer.key_id,
			);
	}
	return (pointer) =>
		(verify as Verify)(pointerSigningBytes(pointer), pointer.signature);
}

/** True once a pointer's signed deadline has passed. The clock is read only
 * when the pointer carries `expires_at`. */
function isExpired(
	pointer: VersionPointer,
	args: SyncArgs | KeyringSyncArgs,
): boolean {
	if (pointer.expires_at == null) return false;
	const now = (args.now ?? (() => Date.now() / 1000))();
	if (!Number.isFinite(now)) {
		throw new TypeError("sync clock must return finite Unix seconds");
	}
	return now >= pointer.expires_at;
}

async function fetchCapped(
	fetchBytes: FetchBytes,
	url: string,
	maxBytes: number,
	options: FetchBytesOptions = {},
): Promise<Uint8Array> {
	const bytes = await fetchBytes(url, { ...options, maxBytes });
	if (bytes.byteLength > maxBytes) {
		throw new SyncCapError(
			`${url} returned ${bytes.byteLength} bytes > ${maxBytes}-byte response cap`,
		);
	}
	return bytes;
}

async function fetchPointer(
	baseUrl: string,
	fetchBytes: FetchBytes,
	authenticate: PointerAuthenticator,
): Promise<VersionPointer> {
	const raw = await fetchCapped(
		fetchBytes,
		`${baseUrl}/latest`,
		MAX_POINTER_BYTES,
		{ cache: "no-store" },
	);
	const pointer = parseJson(raw, "signed latest pointer");
	assertVersionPointer(pointer);
	await authenticate(pointer);
	return pointer;
}

// ---- Anti-rollback: proof of freshness, never absence of disproof ----------
//
// A validly signed but STALE `/latest` (a replayed old pointer) must not
// downgrade a client that already promoted a newer bundle. Two comparisons can
// supply the proof — a monotonic counter, or a comparable version — and the
// durable active pointer they are read from is untrusted (it survives in OPFS
// across sessions and can be corrupted or tampered with). So each comparison
// answers with what it actually PROVED, and a promote nothing proved is
// refused. Answering "cannot compare" with "then it is not a rollback" is the
// fail-OPEN defect this mirrors out of edge-proc's `cas.py`.

/** What ONE freshness comparison proved. */
type Freshness = "fresh" | "stale" | "undecidable";

/** Optional leading `v`, then dot-separated non-negative integers — and
 * nothing else. A date, a git sha or a pre-release suffix is NOT comparable
 * and must not be guessed at. */
const RELEASE = /^v?\d+(?:\.\d+)*$/u;
const MAX_VERSION_CHARS = 200;

const STALE_SEQUENCE =
	"refusing rollback: sequence is not fresher than the active pointer's";
const STALE_VERSION =
	"refusing rollback: version is older than the active pointer's";
const UNPROVABLE =
	"refusing rollback: neither a monotonic sequence nor a comparable version proves the incoming pointer is fresher";

function parseRelease(version: unknown): readonly number[] | null {
	if (
		typeof version !== "string" ||
		version.length > MAX_VERSION_CHARS ||
		!RELEASE.test(version)
	) {
		return null;
	}
	return version.replace(/^v/u, "").split(".").map(Number);
}

function compareRelease(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

function sameIdentity(a: VersionPointer, b: VersionPointer): boolean {
	return (
		a.manifest_hash === b.manifest_hash &&
		a.version === b.version &&
		(a.bundle_id ?? null) === (b.bundle_id ?? null) &&
		(a.channel ?? null) === (b.channel ?? null)
	);
}

/** Monotonic-counter verdict. An active counter that is absent (a pre-sequence
 * store) or unparseable (a corrupted one) has no counter state to compare, so
 * it decides nothing and the version is left to speak. */
function sequenceFreshness(
	incoming: VersionPointer,
	active: VersionPointer,
): Freshness {
	const counter = active.sequence;
	if (!Number.isSafeInteger(counter) || counter < 0) return "undecidable";
	if (incoming.sequence > counter) return "fresh";
	if (incoming.sequence < counter) return "stale";
	// Equal counters: re-promoting the SAME identity is idempotent, anything
	// else is a publisher equivocating at one sequence.
	return sameIdentity(incoming, active) ? "fresh" : "stale";
}

/** Release-version verdict; an unparseable version on either side proves
 * nothing. Equal versions prove freshness only for the same manifest — an
 * equal-version fork says nothing about which side is newer. */
function versionFreshness(
	incoming: VersionPointer,
	active: VersionPointer,
): Freshness {
	const here = parseRelease(incoming.version);
	const there = parseRelease(active.version);
	if (here === null || there === null) return "undecidable";
	const order = compareRelease(here, there);
	if (order < 0) return "stale";
	if (order > 0) return "fresh";
	return incoming.manifest_hash === active.manifest_hash
		? "fresh"
		: "undecidable";
}

/** Why `incoming` may not replace `active` — or null when it provably may. */
function downgradeReason(
	incoming: VersionPointer,
	active: VersionPointer,
): string | null {
	const sequence = sequenceFreshness(incoming, active);
	if (sequence === "stale") return STALE_SEQUENCE;
	const version = versionFreshness(incoming, active);
	if (version === "stale") return STALE_VERSION;
	if (sequence === "fresh" || version === "fresh") return null;
	return UNPROVABLE;
}

function assertExpectedIdentity(
	pointer: VersionPointer,
	args: SyncArgs | KeyringSyncArgs,
): void {
	if (
		args.expectedBundleId !== undefined &&
		(pointer.bundle_id ?? null) !== args.expectedBundleId
	) {
		throw new IntegrityError(
			"signed pointer does not match expected bundle identity",
		);
	}
	if (
		args.expectedChannel !== undefined &&
		(pointer.channel ?? null) !== args.expectedChannel
	) {
		throw new IntegrityError(
			"signed pointer does not match expected release channel",
		);
	}
}

function report(
	args: SyncArgs | KeyringSyncArgs,
	progress: SyncProgress,
): void {
	try {
		args.onProgress?.(progress);
	} catch {
		// Observability cannot acquire authority over promotion or integrity.
	}
}

function validateWantedPaths(paths: ReadonlyArray<string> | undefined): void {
	if (paths === undefined) return;
	if (paths.length > MAX_SYNC_FILES) {
		throw new SyncCapError(`wantedPaths exceeds ${MAX_SYNC_FILES}-path cap`);
	}
	const unique = new Set<string>();
	for (const path of paths) {
		assertSafePath(path);
		if (unique.has(path)) {
			throw new IntegrityError(`wantedPaths repeats path ${path}`);
		}
		unique.add(path);
	}
}

function selectedFiles(
	manifest: IndexManifest,
	paths: ReadonlyArray<string> | undefined,
): ReadonlyArray<FileEntry> {
	if (paths === undefined) return manifest.files;
	const selected = new Set<string>();
	for (const path of paths) {
		const matches = manifest.files.filter((entry) =>
			path.endsWith("/") ? entry.path.startsWith(path) : entry.path === path,
		);
		if (matches.length === 0) {
			throw new IntegrityError(
				`wanted path ${path} is not in the signed manifest`,
			);
		}
		for (const entry of matches) selected.add(entry.path);
	}
	return manifest.files.filter((entry) => selected.has(entry.path));
}

function assertSafePath(path: unknown): asserts path is string {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.length > 1024 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").includes("..")
	) {
		throw new IntegrityError(`manifest contains unsafe path ${String(path)}`);
	}
}

function checkedAdd(total: number, value: number, label: string): number {
	const result = total + value;
	if (!Number.isSafeInteger(result)) {
		throw new SyncCapError(`${label} exceeds safe integer range`);
	}
	return result;
}

function assertManifest(
	value: unknown,
	pointer: VersionPointer,
): asserts value is IndexManifest {
	const manifest = objectAt(value, "manifest");
	if (
		manifest.schema_version !== 2 ||
		typeof manifest.bundle_id !== "string" ||
		typeof manifest.version !== "string" ||
		!Array.isArray(manifest.files) ||
		manifest.files.length > MAX_SYNC_FILES
	) {
		throw new SyncCapError(
			`manifest schema/shape/file count is invalid (expected schema 2; maximum ${MAX_SYNC_FILES} files)`,
		);
	}
	if (manifest.version !== pointer.version) {
		throw new IntegrityError("pointer and manifest versions differ");
	}
	if (pointer.bundle_id != null && manifest.bundle_id !== pointer.bundle_id) {
		throw new IntegrityError("pointer and manifest bundle identities differ");
	}
	const paths = new Set<string>();
	const chunks = new Map<string, number>();
	let references = 0;
	let totalFiles = 0;
	for (const rawFile of manifest.files) {
		const file = objectAt(rawFile, "manifest file");
		assertSafePath(file.path);
		if (paths.has(file.path)) {
			throw new IntegrityError(`manifest repeats path ${file.path}`);
		}
		paths.add(file.path);
		assertHash(file.file_sha256, `file ${file.path} hash`);
		assertBoundedInteger(file.size, `file ${file.path} size`, MAX_FILE_BYTES);
		if (!Array.isArray(file.chunks)) {
			throw new IntegrityError(`file ${file.path} chunks must be an array`);
		}
		let assembledSize = 0;
		for (const rawRef of file.chunks) {
			const ref = objectAt(rawRef, `file ${file.path} chunk`);
			assertHash(ref.hash, `file ${file.path} chunk hash`);
			assertBoundedInteger(
				ref.size,
				`chunk ${ref.hash} size`,
				MAX_DECOMPRESSED_CHUNK_BYTES,
			);
			references += 1;
			if (references > MAX_CHUNK_REFS) {
				throw new SyncCapError(
					`manifest exceeds ${MAX_CHUNK_REFS} chunk-reference cap`,
				);
			}
			const previous = chunks.get(ref.hash);
			if (previous !== undefined && previous !== ref.size) {
				throw new IntegrityError(`chunk ${ref.hash} has conflicting sizes`);
			}
			chunks.set(ref.hash, ref.size);
			assembledSize = checkedAdd(assembledSize, ref.size, "file size");
		}
		if (assembledSize !== file.size) {
			throw new IntegrityError(
				`file ${file.path} declares ${file.size} bytes but chunks total ${assembledSize}`,
			);
		}
		totalFiles = checkedAdd(totalFiles, file.size, "manifest file bytes");
	}
	if (chunks.size > MAX_DISTINCT_CHUNKS) {
		throw new SyncCapError(
			`manifest exceeds ${MAX_DISTINCT_CHUNKS} distinct-chunk cap`,
		);
	}
	let totalChunks = 0;
	for (const size of chunks.values()) {
		totalChunks = checkedAdd(totalChunks, size, "manifest chunk bytes");
	}
	if (
		totalFiles > MAX_TOTAL_UNCOMPRESSED_BYTES ||
		totalChunks > MAX_TOTAL_UNCOMPRESSED_BYTES
	) {
		throw new SyncCapError(
			`manifest exceeds ${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte uncompressed cap`,
		);
	}
}

async function fetchManifest(
	baseUrl: string,
	pointer: VersionPointer,
	fetchBytes: FetchBytes,
	store: CacheStore,
): Promise<IndexManifest> {
	const raw = await fetchCapped(
		fetchBytes,
		`${baseUrl}/manifest/${pointer.manifest_hash}`,
		MAX_MANIFEST_BYTES,
	);
	if ((await sha256Hex(raw)) !== pointer.manifest_hash) {
		throw new IntegrityError(
			`manifest ${pointer.manifest_hash} failed content-address check`,
		);
	}
	const manifest = parseJson(raw, "manifest");
	assertManifest(manifest, pointer);
	await store.putManifest(raw);
	return manifest;
}

async function missingChunks(
	files: ReadonlyArray<FileEntry>,
	store: CacheStore,
): Promise<{
	readonly missing: ReadonlyArray<ChunkRef>;
	readonly reused: number;
}> {
	const wanted = new Map<string, ChunkRef>();
	for (const entry of files) {
		for (const ref of entry.chunks) wanted.set(ref.hash, ref);
	}
	const refs = [...wanted.values()];
	const present = await mapBounded(refs, MAX_CONCURRENT_CHUNK_READS, (ref) =>
		store.hasChunk(ref.hash),
	);
	const missing = refs.filter((_, index) => !present[index]);
	return { missing, reused: wanted.size - missing.length };
}

function totalFetchLimit(args: SyncArgs | KeyringSyncArgs): number {
	const requested = args.limits?.maxTotalFetchBytes;
	if (requested === undefined) return MAX_TOTAL_FETCH_BYTES;
	if (!Number.isSafeInteger(requested) || requested < 1) {
		throw new SyncCapError(
			"aggregate fetch cap must be a positive safe integer",
		);
	}
	return Math.min(requested, MAX_TOTAL_FETCH_BYTES);
}

interface ChunkTransfer {
	/** Streaming bytes of the current attempt (cumulative, declared total). */
	readonly onBytes: (received: number, total: number | null) => void;
	/** A network failure or stall on this chunk; the next attempt follows. */
	readonly onRetry: (attempt: number, delayMs: number, error: Error) => void;
}

async function fetchChunkWithRetry(
	url: string,
	fetchBytes: FetchBytes,
	maxBytes: number,
	sleep: (milliseconds: number) => Promise<void>,
	transfer: ChunkTransfer,
): Promise<Uint8Array> {
	let lastError: NetworkError | undefined;
	for (let attempt = 0; attempt < CHUNK_FETCH_ATTEMPTS; attempt += 1) {
		try {
			return await fetchCapped(fetchBytes, url, maxBytes, {
				onBytes: transfer.onBytes,
			});
		} catch (error) {
			if (!(error instanceof NetworkError)) throw error;
			lastError = error;
			if (attempt + 1 < CHUNK_FETCH_ATTEMPTS) {
				const backoff = CHUNK_RETRY_BASE_DELAY_MS * 2 ** attempt;
				const delay = backoff + Math.random() * CHUNK_RETRY_BASE_DELAY_MS;
				transfer.onRetry(attempt + 1, delay, error);
				await sleep(delay);
			}
		}
	}
	throw lastError ?? new NetworkError(`chunk ${url} is unreachable`);
}

/**
 * Progress accounting for one fetch pass, in uncompressed bytes (the only
 * size the signed manifest states): completed chunks count in full, in-flight
 * chunks count by the fraction of their declared wire size received so far.
 */
class ChunkProgress {
	readonly #total: number;
	readonly #count: number;
	readonly #report: (progress: SyncProgress) => void;
	readonly #inFlight = new Map<string, number>();
	#done = 0;
	#completed = 0;
	#wireBytes = 0;
	#lastReport = Number.NEGATIVE_INFINITY;

	public constructor(
		missing: ReadonlyArray<ChunkRef>,
		report: (progress: SyncProgress) => void,
	) {
		this.#total = missing.reduce((sum, ref) => sum + ref.size, 0);
		this.#count = missing.length;
		this.#report = report;
	}

	public transfer(ref: ChunkRef): ChunkTransfer {
		return {
			onBytes: (received, declared) => {
				const fraction =
					declared === null || declared <= 0
						? Math.min(ref.size, received)
						: ref.size * Math.min(1, received / declared);
				this.#inFlight.set(ref.hash, fraction);
				this.#emit(false);
			},
			onRetry: (attempt, delayMs, error) => {
				this.#inFlight.delete(ref.hash);
				this.#report({
					phase: "chunkRetry",
					hash: ref.hash,
					attempt,
					maxAttempts: CHUNK_FETCH_ATTEMPTS,
					delayMs,
					reason: error.message,
				});
			},
		};
	}

	/** All bytes are in; the chunk counts as completed once it is stored. */
	public received(ref: ChunkRef): void {
		this.#inFlight.set(ref.hash, ref.size);
	}

	public completed(ref: ChunkRef, wireBytes: number): void {
		this.#inFlight.delete(ref.hash);
		this.#done += ref.size;
		this.#completed += 1;
		this.#wireBytes += wireBytes;
		this.#emit(true);
	}

	#emit(force: boolean): void {
		const now = Date.now();
		if (!force && now - this.#lastReport < PROGRESS_INTERVAL_MS) return;
		this.#lastReport = now;
		let partial = 0;
		for (const fraction of this.#inFlight.values()) partial += fraction;
		this.#report({
			phase: "chunks",
			fetchedChunks: this.#completed,
			totalChunks: this.#count,
			bytesFetched: this.#wireBytes,
			bytesTotal: this.#total,
			bytesDone: this.#done + Math.floor(partial),
		});
	}
}

type StoreChunk = (ref: ChunkRef, compressed: Uint8Array) => Promise<void>;

/** Per-chunk storage: what every CacheStore supports. */
function storeEach(store: CacheStore, progress: ChunkProgress): StoreChunk {
	return async (ref, compressed) => {
		await store.putChunkCompressed(ref.hash, compressed, ref.size);
		progress.completed(ref, compressed.byteLength);
	};
}

interface BatchWriter {
	readonly add: StoreChunk;
	/** Land whatever is still pending; rejects with any earlier write failure. */
	readonly flush: () => Promise<void>;
}

/** Groups fetched chunks into batches for `putChunksCompressed`. Batches are
 * written one after another; the fetch worker that fills a batch waits for it
 * to land, which bounds the bytes held in memory. */
function batchWriter(
	putBatch: (chunks: ReadonlyArray<CompressedChunk>) => Promise<void>,
	progress: ChunkProgress,
): BatchWriter {
	let pending: CompressedChunk[] = [];
	let pendingBytes = 0;
	let written: Promise<void> = Promise.resolve();
	const flush = (): Promise<void> => {
		const batch = pending;
		pending = [];
		pendingBytes = 0;
		if (batch.length > 0) {
			written = written.then(async () => {
				await putBatch(batch);
				for (const chunk of batch) {
					progress.completed(chunk, chunk.compressed.byteLength);
				}
			});
		}
		return written;
	};
	const add: StoreChunk = async (ref, compressed) => {
		pending.push({ hash: ref.hash, compressed, size: ref.size });
		pendingBytes += compressed.byteLength;
		progress.received(ref);
		if (
			pending.length >= MAX_STORE_BATCH_CHUNKS ||
			pendingBytes >= MAX_STORE_BATCH_BYTES
		) {
			await flush();
		}
	};
	return { add, flush };
}

function chunkSink(store: CacheStore, progress: ChunkProgress): BatchWriter {
	const putBatch = store.putChunksCompressed;
	if (putBatch === undefined) {
		return { add: storeEach(store, progress), flush: () => Promise.resolve() };
	}
	return batchWriter((chunks) => putBatch.call(store, chunks), progress);
}

async function fetchMissing(
	baseUrl: string,
	missing: ReadonlyArray<ChunkRef>,
	fetchBytes: FetchBytes,
	store: CacheStore,
	maxTotalBytes: number,
	progress: ChunkProgress,
	sleep: (milliseconds: number) => Promise<void>,
): Promise<number> {
	let next = 0;
	let total = 0;
	let remaining = maxTotalBytes;
	let inFlight = 0;
	const budgetWaiters: Array<() => void> = [];
	let failure: unknown;
	const sink = chunkSink(store, progress);
	const reserve = async (): Promise<number> => {
		while (remaining === 0 && inFlight > 0 && failure === undefined) {
			await new Promise<void>((resolve) => {
				budgetWaiters.push(resolve);
			});
		}
		if (remaining === 0) return 0;
		const reservation = Math.min(MAX_COMPRESSED_CHUNK_BYTES, remaining);
		remaining -= reservation;
		inFlight += 1;
		return reservation;
	};
	const release = (reservation: number, consumed: number): void => {
		remaining += reservation - consumed;
		inFlight -= 1;
		for (const wake of budgetWaiters.splice(0)) wake();
	};
	const worker = async (): Promise<void> => {
		while (failure === undefined) {
			const ref = missing[next];
			next += 1;
			if (ref === undefined) return;
			const reservation = await reserve();
			if (reservation === 0) {
				failure = new SyncCapError(
					`sync exceeded ${maxTotalBytes}-byte aggregate fetch cap`,
				);
				return;
			}
			let consumed = 0;
			try {
				const compressed = await fetchChunkWithRetry(
					`${baseUrl}/chunk/${ref.hash}`,
					fetchBytes,
					reservation,
					sleep,
					progress.transfer(ref),
				);
				if (failure !== undefined) return;
				consumed = compressed.byteLength;
				total += consumed;
				await sink.add(ref, compressed);
			} catch (error) {
				failure ??=
					error instanceof SyncCapError
						? new SyncCapError(
								`sync exceeded ${maxTotalBytes}-byte aggregate fetch cap`,
							)
						: error;
			} finally {
				release(reservation, consumed);
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(MAX_CONCURRENT_CHUNK_FETCHES, missing.length) },
			worker,
		),
	);
	if (failure !== undefined) throw failure;
	await sink.flush();
	return total;
}

/** Ceiling on concurrent cached-chunk reads and presence probes. A warm boot
 * is dominated by per-chunk storage round trips (an OPFS file handle per
 * chunk), not by hashing; awaiting them one at a time serialised that latency. */
export const MAX_CONCURRENT_CHUNK_READS = 8;

/** Order-preserving map with at most `limit` calls in flight. After the first
 * failure no new call starts, and every started call settles before the
 * rejection, so no store access outlives the caller or its cache lock. */
async function mapBounded<T, R>(
	items: ReadonlyArray<T>,
	limit: number,
	operation: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	let failure: unknown;
	const worker = async (): Promise<void> => {
		while (!failed && next < items.length) {
			const index = next;
			next += 1;
			try {
				results[index] = await operation(items[index] as T);
			} catch (error) {
				if (!failed) failure = error;
				failed = true;
			}
		}
	};
	const workers = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: workers }, worker));
	if (failed) throw failure;
	return results;
}

type ChunkReader = (ref: ChunkRef) => Promise<Uint8Array>;

/** Verified chunk reads shared by one reassembly pass: at most
 * MAX_CONCURRENT_CHUNK_READS in flight in total, never two reads of the same
 * chunk at once (OPFS sync access handles are exclusive per file), and once
 * any read fails every queued read rejects with that same error unread. */
function chunkReader(store: CacheStore): ChunkReader {
	let active = 0;
	let failure: { readonly error: unknown } | null = null;
	const waiting: Array<() => void> = [];
	const inFlight = new Map<string, Promise<Uint8Array>>();
	const run = async (ref: ChunkRef): Promise<Uint8Array> => {
		while (active >= MAX_CONCURRENT_CHUNK_READS) {
			await new Promise<void>((resolve) => waiting.push(resolve));
		}
		if (failure !== null) {
			waiting.shift()?.();
			throw failure.error;
		}
		active += 1;
		try {
			return await store.getChunk(ref.hash, ref.size);
		} catch (error) {
			failure ??= { error };
			throw error;
		} finally {
			active -= 1;
			waiting.shift()?.();
		}
	};
	return (ref) => {
		const pending = inFlight.get(ref.hash);
		if (pending !== undefined) return pending;
		const read = run(ref).finally(() => inFlight.delete(ref.hash));
		inFlight.set(ref.hash, read);
		return read;
	};
}

function concat(
	parts: ReadonlyArray<Uint8Array>,
	expected: number,
): Uint8Array {
	const out = new Uint8Array(expected);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

async function reassemble(
	entry: FileEntry,
	read: ChunkReader,
): Promise<Uint8Array> {
	// Every chunk is still read from storage, decompressed and re-hashed
	// (`getChunk` is fail-closed); only the waiting is overlapped.
	const parts = await mapBounded(
		entry.chunks,
		MAX_CONCURRENT_CHUNK_READS,
		read,
	);
	const blob = concat(parts, entry.size);
	if ((await sha256Hex(blob)) !== entry.file_sha256) {
		throw new IntegrityError(`file ${entry.path} failed reassembly check`);
	}
	return blob;
}

async function verifyReassembly(
	files: ReadonlyArray<FileEntry>,
	store: CacheStore,
	args: SyncArgs | KeyringSyncArgs,
): Promise<void> {
	const read = chunkReader(store);
	let verifiedFiles = 0;
	await mapBounded(files, MAX_CONCURRENT_CHUNK_READS, async (entry) => {
		await reassemble(entry, read);
		verifiedFiles += 1;
		report(args, { phase: "verify", verifiedFiles, totalFiles: files.length });
	});
}

function distinctChunks(files: ReadonlyArray<FileEntry>): number {
	return new Set(files.flatMap((entry) => entry.chunks.map((ref) => ref.hash)))
		.size;
}

/**
 * Offline: serve the cached bundle only under a signature the CURRENT trust
 * root verifies (by `key_id` when present, else any unrevoked key), so a cache
 * signed by a since-revoked key is refused. An expired cached pointer is still
 * served — refusing it would brick an offline PWA holding intact, authentic
 * bytes — but the result carries `expired: true` for the app to surface.
 */
async function syncFromCache(
	store: CacheStore,
	args: SyncArgs | KeyringSyncArgs,
	authenticate: PointerAuthenticator,
): Promise<SyncResult | null> {
	const active = await store.readActive();
	if (active === null) return null;
	assertVersionPointer(active, false);
	await authenticate(active);
	assertExpectedIdentity(active, args);
	const expired = isExpired(active, args);
	const raw = await store.getManifest(active.manifest_hash);
	const manifest = parseJson(raw, "cached manifest");
	assertManifest(manifest, active);
	const files = selectedFiles(manifest, args.wantedPaths);
	report(args, {
		phase: "manifest",
		totalFiles: manifest.files.length,
		selectedFiles: files.length,
	});
	await verifyReassembly(files, store, args);
	return {
		version: active.version,
		manifestHash: active.manifest_hash,
		chunksFetched: 0,
		chunksReused: distinctChunks(files),
		bytesFetched: 0,
		...(expired ? { expired: true as const } : {}),
	};
}

/**
 * The anti-rollback floor: the durable active pointer, read WITHOUT re-verifying
 * its signature under the currently pinned key or keyring.
 *
 * Re-verifying it and discarding it on a SignatureError would let any key
 * change (a planned rotation, or a swapped pinned key) silently reset the
 * floor: the next pointer — including an OLD release re-signed by the new key —
 * would then be promoted with no freshness comparison at all. The floor only
 * ever REFUSES; it never grants trust. Serving the cached bundle still demands
 * a signature valid under the current trust root (`syncFromCache`), so a
 * pointer it cannot verify — including one signed by a since-revoked key — is
 * a floor but never a source of bytes. This
 * matches edge-proc's `cas.py`, which never re-verifies its stored pointer.
 *
 * The cost is deliberate and fail-closed: a corrupted or tampered durable
 * counter can only make the client refuse updates (a `RollbackError`, recovered
 * by an explicit cache clear), never accept an older release.
 */
async function rollbackFloor(
	store: CacheStore,
	args: SyncArgs | KeyringSyncArgs,
): Promise<VersionPointer | null> {
	const active = await store.readActive();
	if (active === null) return null;
	assertVersionPointer(active, false);
	assertExpectedIdentity(active, args);
	return active;
}

/**
 * Sync the signed bundle at `baseUrl` into `store`, verified by exactly one
 * of `verify` (a single verifier) or `keyring` (key selection + revocation).
 * A network pointer at or past its signed `expires_at` is refused with
 * {@link PointerExpiredError}; an offline sync may still serve an expired
 * cached bundle, flagged `expired: true`.
 */
export async function syncIndex(
	args: SyncArgs | KeyringSyncArgs,
): Promise<SyncResult> {
	validateWantedPaths(args.wantedPaths);
	const authenticate = await pointerAuthenticator(args);
	const { baseUrl, store, fetchBytes } = args;
	let pointer: VersionPointer;
	try {
		pointer = await fetchPointer(baseUrl, fetchBytes, authenticate);
	} catch (error) {
		if (error instanceof NetworkError) {
			const cached = await syncFromCache(store, args, authenticate);
			if (cached !== null) return cached;
		}
		throw error;
	}
	if (isExpired(pointer, args)) {
		throw new PointerExpiredError();
	}
	assertExpectedIdentity(pointer, args);
	report(args, { phase: "pointer", version: pointer.version });
	const active = await rollbackFloor(store, args);
	const refusal = active === null ? null : downgradeReason(pointer, active);
	if (refusal !== null) {
		throw new RollbackError(refusal);
	}
	try {
		const manifest = await fetchManifest(baseUrl, pointer, fetchBytes, store);
		const files = selectedFiles(manifest, args.wantedPaths);
		report(args, {
			phase: "manifest",
			totalFiles: manifest.files.length,
			selectedFiles: files.length,
		});
		const { missing, reused } = await missingChunks(files, store);
		const bytesFetched = await fetchMissing(
			baseUrl,
			missing,
			fetchBytes,
			store,
			totalFetchLimit(args),
			new ChunkProgress(missing, (progress) => report(args, progress)),
			args.sleep ?? realSleep,
		);
		await verifyReassembly(files, store, args);
		await store.promote(pointer);
		const result = {
			version: pointer.version,
			manifestHash: pointer.manifest_hash,
			chunksFetched: missing.length,
			chunksReused: reused,
			bytesFetched,
		};
		report(args, { phase: "promoted", result });
		return result;
	} catch (error) {
		if (active !== null && isQuotaError(error)) {
			try {
				const cached = await syncFromCache(store, args, authenticate);
				if (cached !== null) return cached;
			} catch {
				// A partial write must not hide the actionable storage failure behind
				// a secondary missing-chunk/integrity error from the cache fallback.
			}
		}
		throw error;
	}
}

function fileEntry(manifest: IndexManifest, path: string): FileEntry {
	const entry = manifest.files.find((candidate) => candidate.path === path);
	if (entry === undefined) throw new Error(`file ${path} not in manifest`);
	return entry;
}

export async function materializeFile(
	store: CacheStore,
	manifest: IndexManifest,
	path: string,
): Promise<Uint8Array> {
	return reassemble(fileEntry(manifest, path), chunkReader(store));
}
