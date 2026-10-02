// Signed-bundle sync state machine. Every attacker-controlled dimension is
// bounded before allocation/fetch, and promotion remains the final operation.
import { optionalExpiry, optionalKeyId } from "./activePointer.js";
import { canonicalBytes } from "./canonical.js";
import { sha256Hex } from "./crypto.js";
import { NetworkError } from "./fetchBytes.js";
import { IntegrityError, MAX_DECOMPRESSED_CHUNK_BYTES } from "./integrity.js";
import { assertKeyring, verifyWithKeyring } from "./keyring.js";
import { isQuotaError } from "./storageError.js";
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
/** Maximum silent backoff before one chunk fetch is declared unreachable. */
export const MAX_CHUNK_RETRY_BUDGET_MS = CHUNK_RETRY_BASE_DELAY_MS * (2 ** (CHUNK_FETCH_ATTEMPTS - 1) - 1) +
    CHUNK_RETRY_BASE_DELAY_MS * (CHUNK_FETCH_ATTEMPTS - 1);
const realSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export class SyncCapError extends IntegrityError {
    constructor(message) {
        super(message);
        this.name = "SyncCapError";
    }
}
export class RollbackError extends IntegrityError {
    constructor(message) {
        super(message);
        this.name = "RollbackError";
    }
}
/** A validly signed network pointer is at or past its signed `expires_at`:
 * the publisher no longer vouches that it is current (a freeze/replay). */
export class PointerExpiredError extends IntegrityError {
    constructor(message = "signed latest pointer has expired") {
        super(message);
        this.name = "PointerExpiredError";
    }
}
function parseJson(bytes, label) {
    try {
        return JSON.parse(DECODER.decode(bytes));
    }
    catch (cause) {
        throw new IntegrityError(`${label} is not valid JSON`, { cause });
    }
}
function objectAt(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new IntegrityError(`${label} must be an object`);
    }
    return value;
}
function assertHash(value, label) {
    if (typeof value !== "string" || !SHA256.test(value)) {
        throw new IntegrityError(`${label} must be a lowercase SHA-256 digest`);
    }
}
function assertBoundedInteger(value, label, maximum) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new IntegrityError(`${label} must be a non-negative safe integer`);
    }
    if (value > maximum) {
        throw new SyncCapError(`${label} exceeds ${maximum}-byte cap`);
    }
}
function assertVersionPointer(value, requireSequence = true) {
    const pointer = objectAt(value, "signed latest pointer");
    assertHash(pointer.manifest_hash, "pointer manifest_hash");
    if (typeof pointer.version !== "string" ||
        pointer.version.length === 0 ||
        pointer.version.length > 200 ||
        typeof pointer.signature !== "string" ||
        pointer.signature.length === 0 ||
        pointer.signature.length > 512) {
        throw new IntegrityError("signed latest pointer has invalid version/signature");
    }
    const validSequence = Number.isSafeInteger(pointer.sequence) && pointer.sequence >= 0;
    if ((requireSequence && !validSequence) ||
        (!requireSequence &&
            pointer.sequence !== undefined &&
            pointer.sequence !== null &&
            !validSequence)) {
        throw new IntegrityError("signed latest pointer is missing a non-negative monotonic sequence");
    }
    if (!optionalKeyId(pointer.key_id)) {
        throw new IntegrityError("pointer key_id must be 16 lowercase hex characters or null");
    }
    if (!optionalExpiry(pointer.expires_at)) {
        throw new IntegrityError("pointer expires_at must be a positive safe integer (Unix seconds) or null");
    }
    for (const field of ["bundle_id", "channel"]) {
        const item = pointer[field];
        if (item !== undefined &&
            item !== null &&
            (typeof item !== "string" || item.length > 200)) {
            throw new IntegrityError(`pointer ${field} must be a string of at most 200 characters or null`);
        }
    }
}
/** The exact bytes a pointer's signature covers: canonical JSON without
 * `signature`, and without any optional field that is null or absent — so a
 * pointer that predates an optional field keeps its original preimage. */
export function pointerSigningBytes(pointer) {
    return canonicalBytes(pointer, {
        exclude: {
            signature: true,
            ...(pointer.bundle_id == null ? { bundle_id: true } : {}),
            ...(pointer.channel == null ? { channel: true } : {}),
            ...(pointer.key_id == null ? { key_id: true } : {}),
            ...(pointer.expires_at == null ? { expires_at: true } : {}),
        },
    });
}
async function pointerAuthenticator(args) {
    const { verify, keyring } = args;
    if ((verify === undefined) === (keyring === undefined)) {
        throw new TypeError("syncIndex needs exactly one of verify or keyring");
    }
    if (keyring !== undefined) {
        await assertKeyring(keyring);
        return (pointer) => verifyWithKeyring(keyring, pointerSigningBytes(pointer), pointer.signature, pointer.key_id);
    }
    return (pointer) => verify(pointerSigningBytes(pointer), pointer.signature);
}
/** True once a pointer's signed deadline has passed. The clock is read only
 * when the pointer carries `expires_at`. */
function isExpired(pointer, args) {
    if (pointer.expires_at == null)
        return false;
    const now = (args.now ?? (() => Date.now() / 1000))();
    if (!Number.isFinite(now)) {
        throw new TypeError("sync clock must return finite Unix seconds");
    }
    return now >= pointer.expires_at;
}
async function fetchCapped(fetchBytes, url, maxBytes, options = {}) {
    const bytes = await fetchBytes(url, { ...options, maxBytes });
    if (bytes.byteLength > maxBytes) {
        throw new SyncCapError(`${url} returned ${bytes.byteLength} bytes > ${maxBytes}-byte response cap`);
    }
    return bytes;
}
async function fetchPointer(baseUrl, fetchBytes, authenticate) {
    const raw = await fetchCapped(fetchBytes, `${baseUrl}/latest`, MAX_POINTER_BYTES, { cache: "no-store" });
    const pointer = parseJson(raw, "signed latest pointer");
    assertVersionPointer(pointer);
    await authenticate(pointer);
    return pointer;
}
/** Optional leading `v`, then dot-separated non-negative integers — and
 * nothing else. A date, a git sha or a pre-release suffix is NOT comparable
 * and must not be guessed at. */
const RELEASE = /^v?\d+(?:\.\d+)*$/u;
const MAX_VERSION_CHARS = 200;
const STALE_SEQUENCE = "refusing rollback: sequence is not fresher than the active pointer's";
const STALE_VERSION = "refusing rollback: version is older than the active pointer's";
const UNPROVABLE = "refusing rollback: neither a monotonic sequence nor a comparable version proves the incoming pointer is fresher";
function parseRelease(version) {
    if (typeof version !== "string" ||
        version.length > MAX_VERSION_CHARS ||
        !RELEASE.test(version)) {
        return null;
    }
    return version.replace(/^v/u, "").split(".").map(Number);
}
function compareRelease(a, b) {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0)
            return difference;
    }
    return 0;
}
function sameIdentity(a, b) {
    return (a.manifest_hash === b.manifest_hash &&
        a.version === b.version &&
        (a.bundle_id ?? null) === (b.bundle_id ?? null) &&
        (a.channel ?? null) === (b.channel ?? null));
}
/** Monotonic-counter verdict. An active counter that is absent (a pre-sequence
 * store) or unparseable (a corrupted one) has no counter state to compare, so
 * it decides nothing and the version is left to speak. */
function sequenceFreshness(incoming, active) {
    const counter = active.sequence;
    if (!Number.isSafeInteger(counter) || counter < 0)
        return "undecidable";
    if (incoming.sequence > counter)
        return "fresh";
    if (incoming.sequence < counter)
        return "stale";
    // Equal counters: re-promoting the SAME identity is idempotent, anything
    // else is a publisher equivocating at one sequence.
    return sameIdentity(incoming, active) ? "fresh" : "stale";
}
/** Release-version verdict; an unparseable version on either side proves
 * nothing. Equal versions prove freshness only for the same manifest — an
 * equal-version fork says nothing about which side is newer. */
function versionFreshness(incoming, active) {
    const here = parseRelease(incoming.version);
    const there = parseRelease(active.version);
    if (here === null || there === null)
        return "undecidable";
    const order = compareRelease(here, there);
    if (order < 0)
        return "stale";
    if (order > 0)
        return "fresh";
    return incoming.manifest_hash === active.manifest_hash
        ? "fresh"
        : "undecidable";
}
/** Why `incoming` may not replace `active` — or null when it provably may. */
function downgradeReason(incoming, active) {
    const sequence = sequenceFreshness(incoming, active);
    if (sequence === "stale")
        return STALE_SEQUENCE;
    const version = versionFreshness(incoming, active);
    if (version === "stale")
        return STALE_VERSION;
    if (sequence === "fresh" || version === "fresh")
        return null;
    return UNPROVABLE;
}
function assertExpectedIdentity(pointer, args) {
    if (args.expectedBundleId !== undefined &&
        (pointer.bundle_id ?? null) !== args.expectedBundleId) {
        throw new IntegrityError("signed pointer does not match expected bundle identity");
    }
    if (args.expectedChannel !== undefined &&
        (pointer.channel ?? null) !== args.expectedChannel) {
        throw new IntegrityError("signed pointer does not match expected release channel");
    }
}
function report(args, progress) {
    try {
        args.onProgress?.(progress);
    }
    catch {
        // Observability cannot acquire authority over promotion or integrity.
    }
}
function validateWantedPaths(paths) {
    if (paths === undefined)
        return;
    if (paths.length > MAX_SYNC_FILES) {
        throw new SyncCapError(`wantedPaths exceeds ${MAX_SYNC_FILES}-path cap`);
    }
    const unique = new Set();
    for (const path of paths) {
        assertSafePath(path);
        if (unique.has(path)) {
            throw new IntegrityError(`wantedPaths repeats path ${path}`);
        }
        unique.add(path);
    }
}
function selectedFiles(manifest, paths) {
    if (paths === undefined)
        return manifest.files;
    const selected = new Set();
    for (const path of paths) {
        const matches = manifest.files.filter((entry) => path.endsWith("/") ? entry.path.startsWith(path) : entry.path === path);
        if (matches.length === 0) {
            throw new IntegrityError(`wanted path ${path} is not in the signed manifest`);
        }
        for (const entry of matches)
            selected.add(entry.path);
    }
    return manifest.files.filter((entry) => selected.has(entry.path));
}
function assertSafePath(path) {
    if (typeof path !== "string" ||
        path.length === 0 ||
        path.length > 1024 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").includes("..")) {
        throw new IntegrityError(`manifest contains unsafe path ${String(path)}`);
    }
}
function checkedAdd(total, value, label) {
    const result = total + value;
    if (!Number.isSafeInteger(result)) {
        throw new SyncCapError(`${label} exceeds safe integer range`);
    }
    return result;
}
function assertManifest(value, pointer) {
    const manifest = objectAt(value, "manifest");
    if (manifest.schema_version !== 2 ||
        typeof manifest.bundle_id !== "string" ||
        typeof manifest.version !== "string" ||
        !Array.isArray(manifest.files) ||
        manifest.files.length > MAX_SYNC_FILES) {
        throw new SyncCapError(`manifest schema/shape/file count is invalid (expected schema 2; maximum ${MAX_SYNC_FILES} files)`);
    }
    if (manifest.version !== pointer.version) {
        throw new IntegrityError("pointer and manifest versions differ");
    }
    if (pointer.bundle_id != null && manifest.bundle_id !== pointer.bundle_id) {
        throw new IntegrityError("pointer and manifest bundle identities differ");
    }
    const paths = new Set();
    const chunks = new Map();
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
            assertBoundedInteger(ref.size, `chunk ${ref.hash} size`, MAX_DECOMPRESSED_CHUNK_BYTES);
            references += 1;
            if (references > MAX_CHUNK_REFS) {
                throw new SyncCapError(`manifest exceeds ${MAX_CHUNK_REFS} chunk-reference cap`);
            }
            const previous = chunks.get(ref.hash);
            if (previous !== undefined && previous !== ref.size) {
                throw new IntegrityError(`chunk ${ref.hash} has conflicting sizes`);
            }
            chunks.set(ref.hash, ref.size);
            assembledSize = checkedAdd(assembledSize, ref.size, "file size");
        }
        if (assembledSize !== file.size) {
            throw new IntegrityError(`file ${file.path} declares ${file.size} bytes but chunks total ${assembledSize}`);
        }
        totalFiles = checkedAdd(totalFiles, file.size, "manifest file bytes");
    }
    if (chunks.size > MAX_DISTINCT_CHUNKS) {
        throw new SyncCapError(`manifest exceeds ${MAX_DISTINCT_CHUNKS} distinct-chunk cap`);
    }
    let totalChunks = 0;
    for (const size of chunks.values()) {
        totalChunks = checkedAdd(totalChunks, size, "manifest chunk bytes");
    }
    if (totalFiles > MAX_TOTAL_UNCOMPRESSED_BYTES ||
        totalChunks > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        throw new SyncCapError(`manifest exceeds ${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte uncompressed cap`);
    }
}
async function fetchManifest(baseUrl, pointer, fetchBytes, store) {
    const raw = await fetchCapped(fetchBytes, `${baseUrl}/manifest/${pointer.manifest_hash}`, MAX_MANIFEST_BYTES);
    if ((await sha256Hex(raw)) !== pointer.manifest_hash) {
        throw new IntegrityError(`manifest ${pointer.manifest_hash} failed content-address check`);
    }
    const manifest = parseJson(raw, "manifest");
    assertManifest(manifest, pointer);
    await store.putManifest(raw);
    return manifest;
}
async function missingChunks(files, store) {
    const wanted = new Map();
    for (const entry of files) {
        for (const ref of entry.chunks)
            wanted.set(ref.hash, ref);
    }
    const refs = [...wanted.values()];
    const present = await mapBounded(refs, MAX_CONCURRENT_CHUNK_READS, (ref) => store.hasChunk(ref.hash));
    const missing = refs.filter((_, index) => !present[index]);
    return { missing, reused: wanted.size - missing.length };
}
function totalFetchLimit(args) {
    const requested = args.limits?.maxTotalFetchBytes;
    if (requested === undefined)
        return MAX_TOTAL_FETCH_BYTES;
    if (!Number.isSafeInteger(requested) || requested < 1) {
        throw new SyncCapError("aggregate fetch cap must be a positive safe integer");
    }
    return Math.min(requested, MAX_TOTAL_FETCH_BYTES);
}
async function fetchChunkWithRetry(url, fetchBytes, maxBytes, sleep, transfer) {
    let lastError;
    for (let attempt = 0; attempt < CHUNK_FETCH_ATTEMPTS; attempt += 1) {
        try {
            return await fetchCapped(fetchBytes, url, maxBytes, {
                onBytes: transfer.onBytes,
            });
        }
        catch (error) {
            if (!(error instanceof NetworkError))
                throw error;
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
    #total;
    #count;
    #report;
    #inFlight = new Map();
    #done = 0;
    #completed = 0;
    #wireBytes = 0;
    #lastReport = Number.NEGATIVE_INFINITY;
    constructor(missing, report) {
        this.#total = missing.reduce((sum, ref) => sum + ref.size, 0);
        this.#count = missing.length;
        this.#report = report;
    }
    transfer(ref) {
        return {
            onBytes: (received, declared) => {
                const fraction = declared === null || declared <= 0
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
    completed(ref, wireBytes) {
        this.#inFlight.delete(ref.hash);
        this.#done += ref.size;
        this.#completed += 1;
        this.#wireBytes += wireBytes;
        this.#emit(true);
    }
    #emit(force) {
        const now = Date.now();
        if (!force && now - this.#lastReport < PROGRESS_INTERVAL_MS)
            return;
        this.#lastReport = now;
        let partial = 0;
        for (const fraction of this.#inFlight.values())
            partial += fraction;
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
async function fetchMissing(baseUrl, missing, fetchBytes, store, maxTotalBytes, progress, sleep) {
    let next = 0;
    let total = 0;
    let remaining = maxTotalBytes;
    let inFlight = 0;
    const budgetWaiters = [];
    let failure;
    const reserve = async () => {
        while (remaining === 0 && inFlight > 0 && failure === undefined) {
            await new Promise((resolve) => {
                budgetWaiters.push(resolve);
            });
        }
        if (remaining === 0)
            return 0;
        const reservation = Math.min(MAX_COMPRESSED_CHUNK_BYTES, remaining);
        remaining -= reservation;
        inFlight += 1;
        return reservation;
    };
    const release = (reservation, consumed) => {
        remaining += reservation - consumed;
        inFlight -= 1;
        for (const wake of budgetWaiters.splice(0))
            wake();
    };
    const worker = async () => {
        while (failure === undefined) {
            const ref = missing[next];
            next += 1;
            if (ref === undefined)
                return;
            const reservation = await reserve();
            if (reservation === 0) {
                failure = new SyncCapError(`sync exceeded ${maxTotalBytes}-byte aggregate fetch cap`);
                return;
            }
            let consumed = 0;
            try {
                const compressed = await fetchChunkWithRetry(`${baseUrl}/chunk/${ref.hash}`, fetchBytes, reservation, sleep, progress.transfer(ref));
                if (failure !== undefined)
                    return;
                consumed = compressed.byteLength;
                total += consumed;
                await store.putChunkCompressed(ref.hash, compressed, ref.size);
                progress.completed(ref, consumed);
            }
            catch (error) {
                failure ??=
                    error instanceof SyncCapError
                        ? new SyncCapError(`sync exceeded ${maxTotalBytes}-byte aggregate fetch cap`)
                        : error;
            }
            finally {
                release(reservation, consumed);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_CHUNK_FETCHES, missing.length) }, worker));
    if (failure !== undefined)
        throw failure;
    return total;
}
/** Ceiling on concurrent cached-chunk reads and presence probes. A warm boot
 * is dominated by per-chunk storage round trips (an OPFS file handle per
 * chunk), not by hashing; awaiting them one at a time serialised that latency. */
export const MAX_CONCURRENT_CHUNK_READS = 8;
/** Order-preserving map with at most `limit` calls in flight. After the first
 * failure no new call starts, and every started call settles before the
 * rejection, so no store access outlives the caller or its cache lock. */
async function mapBounded(items, limit, operation) {
    const results = new Array(items.length);
    let next = 0;
    let failed = false;
    let failure;
    const worker = async () => {
        while (!failed && next < items.length) {
            const index = next;
            next += 1;
            try {
                results[index] = await operation(items[index]);
            }
            catch (error) {
                if (!failed)
                    failure = error;
                failed = true;
            }
        }
    };
    const workers = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workers }, worker));
    if (failed)
        throw failure;
    return results;
}
/** Verified chunk reads shared by one reassembly pass: at most
 * MAX_CONCURRENT_CHUNK_READS in flight in total, never two reads of the same
 * chunk at once (OPFS sync access handles are exclusive per file), and once
 * any read fails every queued read rejects with that same error unread. */
function chunkReader(store) {
    let active = 0;
    let failure = null;
    const waiting = [];
    const inFlight = new Map();
    const run = async (ref) => {
        while (active >= MAX_CONCURRENT_CHUNK_READS) {
            await new Promise((resolve) => waiting.push(resolve));
        }
        if (failure !== null) {
            waiting.shift()?.();
            throw failure.error;
        }
        active += 1;
        try {
            return await store.getChunk(ref.hash, ref.size);
        }
        catch (error) {
            failure ??= { error };
            throw error;
        }
        finally {
            active -= 1;
            waiting.shift()?.();
        }
    };
    return (ref) => {
        const pending = inFlight.get(ref.hash);
        if (pending !== undefined)
            return pending;
        const read = run(ref).finally(() => inFlight.delete(ref.hash));
        inFlight.set(ref.hash, read);
        return read;
    };
}
function concat(parts, expected) {
    const out = new Uint8Array(expected);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.byteLength;
    }
    return out;
}
async function reassemble(entry, read) {
    // Every chunk is still read from storage, decompressed and re-hashed
    // (`getChunk` is fail-closed); only the waiting is overlapped.
    const parts = await mapBounded(entry.chunks, MAX_CONCURRENT_CHUNK_READS, read);
    const blob = concat(parts, entry.size);
    if ((await sha256Hex(blob)) !== entry.file_sha256) {
        throw new IntegrityError(`file ${entry.path} failed reassembly check`);
    }
    return blob;
}
async function verifyReassembly(files, store, args) {
    const read = chunkReader(store);
    let verifiedFiles = 0;
    await mapBounded(files, MAX_CONCURRENT_CHUNK_READS, async (entry) => {
        await reassemble(entry, read);
        verifiedFiles += 1;
        report(args, { phase: "verify", verifiedFiles, totalFiles: files.length });
    });
}
function distinctChunks(files) {
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
async function syncFromCache(store, args, authenticate) {
    const active = await store.readActive();
    if (active === null)
        return null;
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
        ...(expired ? { expired: true } : {}),
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
async function rollbackFloor(store, args) {
    const active = await store.readActive();
    if (active === null)
        return null;
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
export async function syncIndex(args) {
    validateWantedPaths(args.wantedPaths);
    const authenticate = await pointerAuthenticator(args);
    const { baseUrl, store, fetchBytes } = args;
    let pointer;
    try {
        pointer = await fetchPointer(baseUrl, fetchBytes, authenticate);
    }
    catch (error) {
        if (error instanceof NetworkError) {
            const cached = await syncFromCache(store, args, authenticate);
            if (cached !== null)
                return cached;
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
        const bytesFetched = await fetchMissing(baseUrl, missing, fetchBytes, store, totalFetchLimit(args), new ChunkProgress(missing, (progress) => report(args, progress)), args.sleep ?? realSleep);
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
    }
    catch (error) {
        if (active !== null && isQuotaError(error)) {
            try {
                const cached = await syncFromCache(store, args, authenticate);
                if (cached !== null)
                    return cached;
            }
            catch {
                // A partial write must not hide the actionable storage failure behind
                // a secondary missing-chunk/integrity error from the cache fallback.
            }
        }
        throw error;
    }
}
function fileEntry(manifest, path) {
    const entry = manifest.files.find((candidate) => candidate.path === path);
    if (entry === undefined)
        throw new Error(`file ${path} not in manifest`);
    return entry;
}
export async function materializeFile(store, manifest, path) {
    return reassemble(fileEntry(manifest, path), chunkReader(store));
}
//# sourceMappingURL=sync.js.map