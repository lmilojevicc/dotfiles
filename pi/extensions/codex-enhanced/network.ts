export const CODEX_RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const CODEX_REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = typeof globalThis.fetch;

type FetchJsonDependencies = {
	fetch?: FetchLike;
	maxBytes?: number;
	timeoutMs?: number;
};

export function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function requestSignal(signal?: AbortSignal, timeoutMs = CODEX_REQUEST_TIMEOUT_MS): AbortSignal {
	const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function cancelAndRelease(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		void reader.cancel().catch(() => undefined);
	} catch {
		// Cleanup failures are intentionally opaque.
	} finally {
		try { reader.releaseLock(); } catch { /* pending reads release after cancellation */ }
	}
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
	if (!body) return;
	try { void body.cancel().catch(() => undefined); } catch { /* opaque cleanup failure */ }
}

async function readWithSignal(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	signal.throwIfAborted();
	return await new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export async function readBoundedJson(
	response: Response,
	signal: AbortSignal,
	maxBytes = CODEX_RESPONSE_LIMIT_BYTES,
): Promise<unknown> {
	if (!response.body) throw new Error("Codex returned an empty response.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	let complete = false;
	try {
		while (true) {
			const { done, value } = await readWithSignal(reader, signal);
			if (done) {
				complete = true;
				break;
			}
			if (!value) continue;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("Codex response exceeded the size limit.");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		if (!complete) cancelAndRelease(reader);
		else reader.releaseLock();
	}
	return JSON.parse(text) as unknown;
}

export async function fetchBoundedJson(
	url: string,
	options: RequestInit,
	dependencies: FetchJsonDependencies = {},
): Promise<unknown> {
	const signal = requestSignal(options.signal, dependencies.timeoutMs);
	const fetch = dependencies.fetch ?? globalThis.fetch;
	const response = await withAbort(fetch(url, { ...options, signal }), signal);
	if (!response.ok) {
		cancelBody(response.body);
		throw new Error(`Codex request failed (${response.status} ${response.statusText})`);
	}
	return await readBoundedJson(response, signal, dependencies.maxBytes);
}
