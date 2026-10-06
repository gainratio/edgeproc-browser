// Page side of the seal proof: start the Worker, hand it the job, return its
// answer to Playwright.
import type { SealWorkerProof, SealWorkerRequest } from "./seal-worker";

declare global {
	interface Window {
		runSealProof(request: SealWorkerRequest): Promise<SealWorkerProof>;
	}
}

window.runSealProof = (request) =>
	new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./seal-worker.ts", import.meta.url), {
			type: "module",
		});
		worker.onerror = (event) => reject(new Error(event.message));
		worker.onmessage = (
			event: MessageEvent<
				{ ok: true; proof: SealWorkerProof } | { ok: false; error: string }
			>,
		) => {
			worker.terminate();
			if (event.data.ok) resolve(event.data.proof);
			else reject(new Error(event.data.error));
		};
		worker.postMessage(request);
	});
