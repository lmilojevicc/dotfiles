import assert from "node:assert/strict";
import test from "node:test";
import { fetchBoundedJson } from "../network.ts";

function neverCancellingBody(chunks: Uint8Array[] = []): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index++];
			if (chunk) controller.enqueue(chunk);
		},
		cancel() { return new Promise<void>(() => {}); },
	});
}

async function rejectionWithin(promise: Promise<unknown>): Promise<Error> {
	return await Promise.race([
		promise.then(
			() => { throw new Error("expected rejection"); },
			(error) => error instanceof Error ? error : new Error(String(error)),
		),
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error("operation hung")), 500)),
	]);
}

test("bounded JSON rejects oversized bodies without awaiting cancellation", async () => {
	const error = await rejectionWithin(fetchBoundedJson("https://example.invalid", {}, {
		fetch: async () => new Response(neverCancellingBody([new Uint8Array(33)]), { status: 200 }),
		maxBytes: 32,
		timeoutMs: 1_000,
	}));
	assert.equal(error.message, "Codex response exceeded the size limit.");
});

test("bounded JSON times out stalled fetches and stalled bodies", async () => {
	const stalledFetch = await rejectionWithin(fetchBoundedJson("https://example.invalid", {}, {
		fetch: async () => await new Promise<Response>(() => {}),
		timeoutMs: 10,
	}));
	assert.match(stalledFetch.name, /TimeoutError|Error/u);

	const stalledBody = await rejectionWithin(fetchBoundedJson("https://example.invalid", {}, {
		fetch: async () => new Response(neverCancellingBody(), { status: 200 }),
		timeoutMs: 10,
	}));
	assert.match(stalledBody.name, /TimeoutError|Error/u);
});

test("bounded JSON parses a valid response", async () => {
	assert.deepEqual(await fetchBoundedJson("https://example.invalid", {}, {
		fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
		timeoutMs: 1_000,
	}), { ok: true });
});
