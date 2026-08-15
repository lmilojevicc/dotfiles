import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_CODE_USAGE_LIMITS, CommandCodeUsageError, fetchCommandCodeUsage } from "../src/usage.ts";

function neverCancellingBody(chunks: Uint8Array[] = []): ReadableStream<Uint8Array> {
	let index = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[index++];
			if (chunk) controller.enqueue(chunk);
			// Deliberately leave the stream open after supplied chunks.
		},
		cancel() {
			return new Promise<void>(() => {});
		},
	});
}

async function settlesPromptly(promise: Promise<unknown>): Promise<unknown> {
	return await Promise.race([
		promise.then(
			() => { throw new Error("expected rejection"); },
			(error) => error,
		),
		new Promise((_, reject) => setTimeout(() => reject(new Error("operation hung")), 500)),
	]);
}

test("usage timeout settles despite a never-resolving body cancellation", async () => {
	const error = await settlesPromptly(fetchCommandCodeUsage({
		apiKey: "secret-api-key",
		timeoutMs: 10,
		fetch: async () => new Response(neverCancellingBody(), { status: 200 }),
	}));
	assert.ok(error instanceof CommandCodeUsageError);
	assert.equal((error as Error).message, "Command Code usage request timed out.");
	assert.equal((error as Error).message.includes("secret-api-key"), false);
});

test("usage size failure settles despite a never-resolving cancellation", async () => {
	const oversized = new Uint8Array(COMMAND_CODE_USAGE_LIMITS.responseBytes + 1);
	const error = await settlesPromptly(fetchCommandCodeUsage({
		apiKey: "secret-api-key",
		timeoutMs: 1_000,
		fetch: async () => new Response(neverCancellingBody([oversized]), { status: 200 }),
	}));
	assert.ok(error instanceof CommandCodeUsageError);
	assert.equal((error as Error).message, "Command Code usage response exceeded the size limit.");
	assert.equal((error as Error).message.includes("secret-api-key"), false);
});

test("non-OK usage cleanup does not await body cancellation", async () => {
	const error = await settlesPromptly(fetchCommandCodeUsage({
		apiKey: "secret-api-key",
		fetch: async () => new Response(neverCancellingBody(), { status: 503 }),
	}));
	assert.ok(error instanceof CommandCodeUsageError);
	assert.equal((error as Error).message, "Command Code usage is temporarily unavailable.");
});
