import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FETCH_STALL_TIMEOUT_MS,
	fetchBytes,
	NetworkError,
	ResponseTooLargeError,
} from "./fetchBytes.js";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("fetchBytes release bounds", () => {
	it("times out even when the fetch promise ignores AbortSignal", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => new Promise<Response>(() => undefined)),
		);

		const pending = fetchBytes("https://origin.example/never");
		const assertion = expect(pending).rejects.toBeInstanceOf(NetworkError);
		await vi.advanceTimersByTimeAsync(FETCH_STALL_TIMEOUT_MS);
		await assertion;
	});

	// Headers arriving is not the request finishing. The obvious implementation
	// clears the deadline once `fetch()` resolves — but `fetch()` resolves on the
	// RESPONSE HEAD, so a server that sends `200 OK`, one byte, and then nothing
	// forever leaves the caller hanging with the timer already cleared. The
	// deadline has to cover the body read, not just the handshake.
	it("keeps the deadline active after headers while the body stalls", async () => {
		vi.useFakeTimers();
		const stalled = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			pull: () => new Promise<void>(() => undefined),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(stalled, { status: 200 }))),
		);

		const pending = fetchBytes("https://origin.example/stalled-body");
		const assertion = expect(pending).rejects.toThrow(
			new RegExp(`stalled: no bytes for ${FETCH_STALL_TIMEOUT_MS}ms`, "u"),
		);
		await vi.advanceTimersByTimeAsync(FETCH_STALL_TIMEOUT_MS);
		await assertion;
		await expect(pending).rejects.toBeInstanceOf(NetworkError);
	});

	// A slow link is not a dead link. The old 15 s wall clock counted from the
	// request start, so a 64 KB chunk that legitimately takes 40 s on a bad
	// mobile link (and keeps delivering bytes the whole time) was aborted,
	// retried, and aborted again: on slow 4G every chunk fetch was "failing"
	// while the network was fine. The deadline is a STALL window: it only fires
	// when nothing has arrived for FETCH_STALL_TIMEOUT_MS.
	it("keeps reading a body that trickles bytes for longer than any wall clock", async () => {
		vi.useFakeTimers();
		let sent = 0;
		const trickle = new ReadableStream<Uint8Array>({
			pull(controller) {
				return new Promise<void>((resolve) => {
					setTimeout(() => {
						sent += 1;
						controller.enqueue(new Uint8Array([sent]));
						if (sent === 6) controller.close();
						resolve();
					}, 10_000);
				});
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(trickle, { status: 200 }))),
		);

		const pending = fetchBytes("https://origin.example/trickle");
		const assertion = expect(pending).resolves.toEqual(
			new Uint8Array([1, 2, 3, 4, 5, 6]),
		);
		// 60 s of transfer, never more than 10 s between bytes.
		await vi.advanceTimersByTimeAsync(60_000);
		await assertion;
	});

	it("measures the stall from the LAST received byte, not from the request start", async () => {
		vi.useFakeTimers();
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))),
		);
		let settled: "pending" | "resolved" | "rejected" = "pending";
		const pending = fetchBytes("https://origin.example/late-byte");
		pending.then(
			() => {
				settled = "resolved";
			},
			() => {
				settled = "rejected";
			},
		);

		await vi.advanceTimersByTimeAsync(FETCH_STALL_TIMEOUT_MS - 1_000);
		controller.enqueue(new Uint8Array([1])); // one byte, 1 s before the window closes
		await vi.advanceTimersByTimeAsync(FETCH_STALL_TIMEOUT_MS - 1_000);
		// Almost 2 windows since the request started, but under 1 since the byte.
		expect(settled).toBe("pending");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(settled).toBe("rejected");
		await expect(pending).rejects.toThrow(/stalled/u);
	});

	it("reports cumulative received bytes and the declared total while streaming", async () => {
		const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
		let index = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(c) {
				const part = parts[index];
				index += 1;
				if (part === undefined) c.close();
				else c.enqueue(part);
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					new Response(body, {
						status: 200,
						headers: { "content-length": "7" },
					}),
				),
			),
		);
		const seen: Array<[number, number | null]> = [];

		await expect(
			fetchBytes("https://origin.example/progress", {
				onBytes: (received, total) => {
					seen.push([received, total]);
				},
			}),
		).resolves.toHaveLength(7);
		expect(seen).toEqual([
			[3, 7],
			[7, 7],
		]);
	});

	it("streams a response through the caller's byte ceiling", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					new Response(new Uint8Array(9), {
						status: 200,
					}),
				),
			),
		);

		await expect(
			fetchBytes("https://origin.example/oversize", { maxBytes: 8 }),
		).rejects.toBeInstanceOf(ResponseTooLargeError);
	});

	it("fetches mutable latest with no-store while preserving the cap", async () => {
		const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
			Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			fetchBytes("https://origin.example/latest", {
				cache: "no-store",
				maxBytes: 3,
			}),
		).resolves.toEqual(new Uint8Array([1, 2, 3]));
		expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
	});
});
