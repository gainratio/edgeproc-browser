// Bounded browser transport for the signed-bundle sync engine.

import { IntegrityError } from "./integrity.js";
import type { FetchBytes, FetchBytesOptions } from "./types.js";

export class NetworkError extends Error {
	public constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "NetworkError";
	}
}

/** A response crossed its caller-owned byte ceiling. Integrity-class, not a
 * recoverable network outage: sync must never silently serve cache for it. */
export class ResponseTooLargeError extends IntegrityError {
	public constructor(message: string) {
		super(message);
		this.name = "ResponseTooLargeError";
	}
}

/**
 * How long a request may go with NO bytes arriving before it is declared
 * stalled and aborted. This is a stall window, not a wall clock: a transfer
 * that keeps delivering bytes is never cut off, however slow the link. Sized
 * for bad mobile links (radio gaps, cell handovers), where a 15 s wall clock
 * turned a 64 KB chunk that legitimately takes 40 s into a retry storm.
 */
export const FETCH_STALL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_FETCH_BYTES = 2 * 1024 * 1024;

function requestInit(
	signal: AbortSignal,
	options?: FetchBytesOptions,
): RequestInit {
	return options?.cache === undefined
		? { signal }
		: { signal, cache: options.cache };
}

function responseLimit(options?: FetchBytesOptions): number {
	const limit = options?.maxBytes ?? DEFAULT_MAX_FETCH_BYTES;
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new ResponseTooLargeError(`invalid response byte cap ${limit}`);
	}
	return limit;
}

function stalled(url: string): NetworkError {
	return new NetworkError(
		`fetch ${url} failed: stalled: no bytes for ${FETCH_STALL_TIMEOUT_MS}ms`,
	);
}

/** Called each time the request makes observable progress (headers, a body
 * read); re-arms the stall window. */
type Touch = () => void;

/**
 * Run `operation` under a stall watchdog. The watchdog is armed at the start
 * and re-armed on every `touch`; it fires only after FETCH_STALL_TIMEOUT_MS
 * of silence, aborting the request so no socket outlives the rejection.
 */
async function raceStall<T>(
	operation: (touch: Touch) => Promise<T>,
	url: string,
	controller: AbortController,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let fail: (error: Error) => void = () => undefined;
	const stall = new Promise<never>((_resolve, reject) => {
		fail = reject;
	});
	const touch: Touch = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			controller.abort();
			fail(stalled(url));
		}, FETCH_STALL_TIMEOUT_MS);
	};
	touch();
	try {
		return await Promise.race([operation(touch), stall]);
	} finally {
		clearTimeout(timer);
	}
}

function contentLength(response: Response): number | null {
	const raw = response.headers.get("content-length");
	if (raw === null) return null;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function join(parts: ReadonlyArray<Uint8Array>, total: number): Uint8Array {
	const output = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

/** Progress sink for one response body: every read re-arms the stall window
 * and is reported to the caller as (cumulative received, declared total). */
function progressSink(
	response: Response,
	touch: Touch,
	options?: FetchBytesOptions,
): (received: number) => void {
	const declared = contentLength(response);
	return (received) => {
		touch();
		options?.onBytes?.(received, declared);
	};
}

async function readCapped(
	response: Response,
	limit: number,
	onRead: (received: number) => void,
): Promise<Uint8Array> {
	const declared = contentLength(response);
	if (declared !== null && declared > limit) {
		throw new ResponseTooLargeError(
			`response Content-Length ${declared} exceeds ${limit}-byte cap`,
		);
	}
	if (response.body === null) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > limit) {
			throw new ResponseTooLargeError(
				`response body exceeds ${limit}-byte cap`,
			);
		}
		onRead(bytes.byteLength);
		return bytes;
	}
	const reader = response.body.getReader();
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new ResponseTooLargeError(
				`response body exceeds ${limit}-byte cap`,
			);
		}
		parts.push(value);
		onRead(total);
	}
	return join(parts, total);
}

async function fetchAndRead(
	url: string,
	controller: AbortController,
	touch: Touch,
	options?: FetchBytesOptions,
): Promise<Uint8Array> {
	let response: Response;
	try {
		response = await fetch(url, requestInit(controller.signal, options));
	} catch (cause) {
		throw new NetworkError(`fetch ${url} failed: network unreachable`, {
			cause,
		});
	}
	// Headers arriving is progress; the body read re-arms from here on.
	touch();
	if (!response.ok) {
		throw new NetworkError(
			`fetch ${url} failed: ${response.status} ${response.statusText}`,
		);
	}
	return readCapped(
		response,
		responseLimit(options),
		progressSink(response, touch, options),
	);
}

export const fetchBytes: FetchBytes = (url, options) => {
	const controller = new AbortController();
	return raceStall(
		(touch) => fetchAndRead(url, controller, touch, options),
		url,
		controller,
	);
};
