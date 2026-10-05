/// <reference lib="webworker" />

// Imported FIRST by engine-refused-worker.ts: this Worker's OPFS root is refused,
// the way private browsing or a locked-down profile refuses it.
navigator.storage.getDirectory = () =>
	Promise.reject(new DOMException("refused by the test", "SecurityError"));
