import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const piAiStub = `
export function calculateCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}
class EventStream {
  queue = [];
  waiters = [];
  ended = false;
  resultPromise;
  resolveResult;
  constructor() {
    this.resultPromise = new Promise((resolve) => { this.resolveResult = resolve; });
  }
  push(value) {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }
  end(result) {
    if (this.ended) return;
    this.ended = true;
    this.resolveResult(result);
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  next() {
    if (this.queue.length > 0) return Promise.resolve({ value: this.queue.shift(), done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
  result() { return this.resultPromise; }
}
export function createAssistantMessageEventStream() { return new EventStream(); }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-ai") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(piAiStub)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});

const streamModule = import("../src/stream.ts");
const encoder = new TextEncoder();
const model = {
  api: "command-code",
  provider: "command-code",
  id: "test-model",
  input: ["text"],
  reasoning: false,
  contextWindow: 128_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [] };

async function collectErrorMessage(options: Record<string, unknown>): Promise<string> {
  const { streamCommandCode } = await streamModule;
  const stream = streamCommandCode(model as never, context as never, {
    apiKey: "test-key",
    timeoutMs: 30_000,
    ...options,
  } as never);
  let message = "";
  for await (const event of stream) {
    if (event.type === "error") message = event.error.errorMessage ?? "";
  }
  return message;
}

function successfulResponse(body: BodyInit): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

test("external callback failures never expose arbitrary secrets", async () => {
  const secret = "callback-api-key-secret";
  let fetchCalled = false;
  assert.equal(await collectErrorMessage({
    onPayload() {
      throw new Error(`payload failed with ${secret}`);
    },
    fetch() {
      fetchCalled = true;
      throw new Error("must not run");
    },
  }), "Command Code request failed");
  assert.equal(fetchCalled, false);

  assert.equal(await collectErrorMessage({
    fetch: async () => successfulResponse("{}\n"),
    onResponse() {
      throw new Error(`response failed with ${secret}`);
    },
  }), "Command Code request failed");
});

test("rejects an overlong NDJSON event without exposing its content", async () => {
  const secret = "oversized-secret";
  const body = `${secret}${"x".repeat(1024 * 1024)}\n`;
  const message = await collectErrorMessage({ fetch: async () => successfulResponse(body) });
  assert.equal(message, "Command Code stream event exceeded the size limit");
  assert.equal(message.includes(secret), false);
});

test("rejects streams that exceed the event-count limit", async () => {
  const body = encoder.encode("{}\n".repeat(100_001));
  assert.equal(
    await collectErrorMessage({ fetch: async () => successfulResponse(body) }),
    "Command Code stream exceeded the event limit",
  );
});

test("rejects streams that exceed the total-byte limit", async () => {
  const chunk = encoder.encode(`${" ".repeat(1024 * 1024 - 1)}\n`);
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunks >= 65) {
        controller.close();
        return;
      }
      chunks += 1;
      controller.enqueue(chunk);
    },
  });
  assert.equal(
    await collectErrorMessage({ fetch: async () => successfulResponse(body) }),
    "Command Code stream exceeded the size limit",
  );
});

test("terminal account classification inspects structured fields only", async () => {
  const { isTerminalAccountError } = await streamModule;
  assert.equal(isTerminalAccountError({ error: { code: "insufficient_quota", message: "limit reached" } }), true);
  assert.equal(isTerminalAccountError({ unrelated: "quota exceeded" }), false);
});
