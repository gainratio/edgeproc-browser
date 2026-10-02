// Every REFUSAL path of the bounded transport.
//
// fetchBytes is the package's only door to the network, and every branch in it
// exists to say no: the byte cap, the timeout, the unreachable host, the non-2xx
// status. An untested refusal is the shape every hole in this codebase has had
// — the branch reads fine, ships, and never runs. So each `throw` below is
// driven, and each is asserted on its ERROR TYPE, not just on "it rejected":
// ResponseTooLargeError extends IntegrityError precisely so sync treats an
// oversized response as a corruption event and never silently serves cache for
// it. A test that only checked `rejects.toThrow()` would pass if that
// distinction were deleted.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAX_FETCH_BYTES,
	FETCH_STALL_TIMEOUT_MS,
	fetchBytes,
	NetworkError,
	ResponseTooLargeError,
} from "./fetchBytes.js";
import { IntegrityError } from "./integrity.js";

const URL_UNDER_TEST = "https://cdn.example/catalog/latest";

/** A Response whose body streams `chunks` back one read at a time. */
function streaming(
	chunks: readonly Uint8Array[],
	headers: Record<string, string> = {},
): Response {
	let index = 0;
	const body = {
		getReader() {
			return {
				read: () =>
					Promise.resolve(
						index < chunks.length
							? { done: false, value: chunks[index++] }
							: { done: true, value: undefined },
					),
				cancel: () => Promise.resolve(),
			};
		},
	};
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		body,
		headers: new Headers(headers),
	} as unknown as Response;
}

/** A Response with a null body, forcing the arrayBuffer() path. */
function bodyless(bytes: Uint8Array, headers: Record<string, string> = {}) {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		body: null,
		headers: new Headers(headers),
		arrayBuffer: () => Promise.resolve(bytes.buffer),
	} as unknown as Response;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("fetchBytes refuses", () => {
	it("a Content-Length that already declares more than the cap", async () => {
		// Refused on the HEADER, before a single body byte is read — the whole
		// point of reading Content-Length at all.
		const read = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					body: {
						getReader: () => ({ read, cancel: () => Promise.resolve() }),
					},
					headers: new Headers({ "content-length": "4096" }),
				} as unknown as Response),
			),
		);
		await expect(
			fetchBytes(URL_UNDER_TEST, { maxBytes: 1024 }),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
		expect(read).not.toHaveBeenCalled();
	});

	it("a streamed body that crosses the cap mid-flight, and cancels the reader", async () => {
		// A lying (or absent) Content-Length must not get past the running total.
		const cancel = vi.fn(() => Promise.resolve());
		let index = 0;
		const chunks = [new Uint8Array(600), new Uint8Array(600)];
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: true,
					status: 200,
					statusText: "OK",
					body: {
						getReader: () => ({
							read: () =>
								Promise.resolve(
									index < chunks.length
										? { done: false, value: chunks[index++] }
										: { done: true, value: undefined },
								),
							cancel,
						}),
					},
					headers: new Headers(),
				} as unknown as Response),
			),
		);
		await expect(
			fetchBytes(URL_UNDER_TEST, { maxBytes: 1024 }),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
		// Leaving the stream open would keep pulling the oversized body down.
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("an oversized body delivered with no stream (arrayBuffer path)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(bodyless(new Uint8Array(2048)))),
		);
		await expect(
			fetchBytes(URL_UNDER_TEST, { maxBytes: 1024 }),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it.each([
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["not a safe integer", Number.MAX_SAFE_INTEGER + 2],
	])("a caller-supplied byte cap that is %s", async (_label, maxBytes) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(streaming([new Uint8Array(1)]))),
		);
		await expect(
			fetchBytes(URL_UNDER_TEST, { maxBytes }),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("an unreachable host, preserving the underlying cause", async () => {
		const cause = new TypeError("Failed to fetch");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.reject(cause)),
		);
		const error = await fetchBytes(URL_UNDER_TEST).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NetworkError);
		expect((error as NetworkError).cause).toBe(cause);
	});

	it("a non-2xx status, naming it in the message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve({
					ok: false,
					status: 503,
					statusText: "Service Unavailable",
					body: null,
					headers: new Headers(),
				} as unknown as Response),
			),
		);
		const error = await fetchBytes(URL_UNDER_TEST).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(NetworkError);
		expect((error as Error).message).toContain("503");
	});
});

describe("fetchBytes accepts", () => {
	it("a body exactly at the cap — the boundary is inclusive", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(streaming([new Uint8Array(1024)]))),
		);
		const bytes = await fetchBytes(URL_UNDER_TEST, { maxBytes: 1024 });
		expect(bytes.byteLength).toBe(1024);
	});

	it("a multi-chunk body, joined in order", async () => {
		const first = Uint8Array.from([1, 2, 3]);
		const second = Uint8Array.from([4, 5]);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(streaming([first, second]))),
		);
		const bytes = await fetchBytes(URL_UNDER_TEST);
		expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
	});

	it("an unparseable Content-Length by falling back to the running total", async () => {
		// A junk header must neither throw nor be trusted as a bound.
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					streaming([new Uint8Array(8)], { "content-length": "not-a-number" }),
				),
			),
		);
		await expect(
			fetchBytes(URL_UNDER_TEST, { maxBytes: 16 }),
		).resolves.toHaveLength(8);
	});

	it("a caller cache mode, passing it through to fetch", async () => {
		const spy = vi.fn((_url: string, _init: RequestInit) =>
			Promise.resolve(streaming([new Uint8Array(1)])),
		);
		vi.stubGlobal("fetch", spy);
		await fetchBytes(URL_UNDER_TEST, { cache: "no-store" });
		expect(spy.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
	});
});

describe("the transport's shape is pinned, not merely asserted against itself", () => {
	it("caps responses at 2 MiB and declares a stall after 30 s without bytes", () => {
		// Literals, not `EXPECTED === CONSTANT`: a test that compares a constant
		// to itself passes at any value. These are the numbers the docs state.
		// 30 s is sized for bad mobile links (radio gaps, cell handovers), not for
		// a healthy wire: a shorter window turned slow 4G into a sync outage.
		expect(DEFAULT_MAX_FETCH_BYTES).toBe(2 * 1024 * 1024);
		expect(FETCH_STALL_TIMEOUT_MS).toBe(30_000);
	});

	it("classifies an oversized response as an integrity failure, not an outage", () => {
		// This is the contract sync depends on: it may fall back to cache for a
		// NetworkError and must NEVER do so for a size-cap breach.
		const tooLarge = new ResponseTooLargeError("x");
		expect(tooLarge).toBeInstanceOf(IntegrityError);
		expect(new NetworkError("x")).not.toBeInstanceOf(IntegrityError);
	});

	it("aborts the in-flight request when the stall window closes", async () => {
		vi.useFakeTimers();
		let observed: AbortSignal | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((_url: string, init: RequestInit) => {
				observed = init.signal ?? undefined;
				return new Promise<Response>(() => {
					/* never settles — the deadline is the only way out */
				});
			}),
		);
		const pending = fetchBytes(URL_UNDER_TEST);
		const assertion = expect(pending).rejects.toBeInstanceOf(NetworkError);
		await vi.advanceTimersByTimeAsync(FETCH_STALL_TIMEOUT_MS + 1);
		await assertion;
		expect(observed?.aborted).toBe(true);
	});
});
