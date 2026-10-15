// Adapted from codex-enhanced; see the MIT notice in index.ts.
export const RESPONSE_LIMIT_BYTES = 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
const ERROR_BODY_LIMIT_BYTES = 4096;

type FetchLike = typeof globalThis.fetch;

type FetchJsonDependencies = {
	fetch?: FetchLike;
	maxBytes?: number;
	timeoutMs?: number;
	/** Human provider name used in error messages, e.g. "Codex". */
	label?: string;
};

/** Non-2xx response. `body` is a bounded prefix kept for classification only; never render it. */
export class HttpError extends Error {
	readonly status: number;
	readonly body: string;
	constructor(label: string, status: number, statusText: string, body: string) {
		super(`${label} request failed (${status}${statusText ? ` ${statusText}` : ""})`);
		this.name = "HttpError";
		this.status = status;
		this.body = body;
	}
}

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

export function requestSignal(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
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

export function cancelBody(body: ReadableStream<Uint8Array> | null): void {
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

async function readBoundedText(response: Response, signal: AbortSignal, maxBytes: number, truncate: boolean, label: string): Promise<string> {
	if (!response.body) throw new Error(`${label} returned an empty response.`);
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
			if (bytes > maxBytes) {
				if (truncate) break;
				throw new Error(`${label} response exceeded the size limit.`);
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		if (!complete) cancelAndRelease(reader);
		else reader.releaseLock();
	}
	return text;
}

export async function readBoundedJson(response: Response, signal: AbortSignal, maxBytes = RESPONSE_LIMIT_BYTES, label = "Provider"): Promise<unknown> {
	const text = await readBoundedText(response, signal, maxBytes, false, label);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`${label} returned invalid JSON.`);
	}
}

/**
 * Redirects are refused: fetch re-sends custom credential headers such as `X-Management-Key`
 * to a cross-origin redirect target, stripping only `authorization`, `cookie` and the like.
 */
export async function fetchBoundedJson(
	url: string,
	options: RequestInit,
	dependencies: FetchJsonDependencies = {},
): Promise<unknown> {
	const label = dependencies.label ?? "Provider";
	const signal = requestSignal(options.signal ?? undefined, dependencies.timeoutMs);
	const fetch = dependencies.fetch ?? globalThis.fetch;
	const response = await withAbort(fetch(url, { ...options, redirect: "error", signal }), signal);
	if (!response.ok) {
		let body = "";
		try { body = await readBoundedText(response, signal, ERROR_BODY_LIMIT_BYTES, true, label); }
		catch { cancelBody(response.body); }
		throw new HttpError(label, response.status, response.statusText, body);
	}
	return await readBoundedJson(response, signal, dependencies.maxBytes, label);
}

/** Status code of a GET whose body is discarded; undefined on network failure or timeout. */
export async function fetchStatus(url: string, fetch: FetchLike, timeoutMs: number, signal?: AbortSignal): Promise<number | undefined> {
	const combined = requestSignal(signal, timeoutMs);
	try {
		const response = await withAbort(fetch(url, { method: "GET", signal: combined }), combined);
		cancelBody(response.body);
		return response.status;
	} catch {
		return undefined;
	}
}
