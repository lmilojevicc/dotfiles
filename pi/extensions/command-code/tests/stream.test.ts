import assert from "node:assert/strict";
import test from "node:test";
import { embeddedError, forbiddenFieldErrors, opaqueEmbeddedErrors, recognizedEmbeddedErrors } from "./diagnostic-fixtures.ts";

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
  let terminals = 0;
  for await (const event of stream) {
    if (event.type === "error" || event.type === "done") terminals += 1;
    if (event.type === "error") message = event.error.errorMessage ?? "";
  }
  assert.equal(terminals, 1);
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

const secretSentinel = "SECRET_PROMPT_KEY_PATH_ID_SENTINEL";
const categories = [
  ["context_length_exceeded", "context_length_exceeded"],
  ["invalid_tool_call_id", "tool_pairing_or_id"],
  ["invalid_reasoning", "invalid_reasoning"],
  ["unsupported_parameter", "invalid_parameter"],
  ["unknown_error", undefined],
] as const;

test("HTTP and in-band 400s expose only fixed recognized categories, including embedded errors", async () => {
  for (const [code, category] of categories) {
    for (const embedded of [false, true]) {
      const detail = { code, message: secretSentinel, path: secretSentinel, requestId: secretSentinel, headers: { authorization: secretSentinel } };
      const error = embedded ? { message: `Upstream: ${JSON.stringify({ error: detail })}` } : detail;
      for (const inBand of [false, true]) {
        const body = inBand ? JSON.stringify({ type: "error", error: { statusCode: 400, error } }) + "\n" : JSON.stringify({ error });
        const message = await collectErrorMessage({ fetch: async () => new Response(body, { status: inBand ? 200 : 400 }) });
        assert.equal(message, `Command Code ${inBand ? "stream error" : "request failed"} (400)${category ? `: ${category}` : ""}`);
        assert.equal(message.includes(secretSentinel), false);
        assert.ok(message.length < 120);
      }
    }
  }
  // Some gateways embed both the status and upstream validation in a string.
  assert.equal(await collectErrorMessage({ fetch: async () => successfulResponse(JSON.stringify({
    type: "error", error: `Upstream: ${JSON.stringify({ statusCode: 400, error: { code: "invalid_reasoning", message: secretSentinel } })}`,
  }) + "\n") }), "Command Code stream error (400): invalid_reasoning");
});

test("embedded JSON uses the structured allowlist, not serialized unknown fields", async () => {
  for (const inBand of [false, true]) {
    for (const fixture of forbiddenFieldErrors) {
      for (const error of [fixture, embeddedError(fixture)]) {
        const body = inBand ? { type: "error", statusCode: 400, error } : { error };
        assert.equal(await collectErrorMessage({ fetch: async () => Response.json(body, { status: inBand ? 200 : 400 }) }),
          `Command Code ${inBand ? "stream error" : "request failed"} (400)`);
      }
    }
    for (const [fixture, category] of recognizedEmbeddedErrors) {
      for (const error of [fixture, embeddedError(fixture)]) {
        const body = inBand ? { type: "error", error: { statusCode: 400, error } } : { error };
        assert.equal(await collectErrorMessage({ fetch: async () => Response.json(body, { status: inBand ? 200 : 400 }) }),
          category === "quota" ? "Command Code quota exceeded" : `Command Code ${inBand ? "stream error" : "request failed"} (400): ${category}`);
      }
    }
  }
});

for (const [name, error] of opaqueEmbeddedErrors) {
  test(`opaque embedded diagnostics preserve status only: ${name}`, async () => {
    const { isTerminalAccountError } = await streamModule;
    assert.equal(isTerminalAccountError(error), false);
    for (const inBand of [false, true]) {
      const body = inBand ? { type: "error", statusCode: 400, error } : { error };
      assert.equal(await collectErrorMessage({ fetch: async () => Response.json(body, { status: inBand ? 200 : 400 }) }),
        `Command Code ${inBand ? "stream error" : "request failed"} (400)`, inBand ? "in-band" : "HTTP");
    }
  });
}

test("embedded JSON occupies the structured position at the container depth boundary", async () => {
  for (const inBand of [false, true]) {
    for (const wrappers of [3, 4]) {
      let fixture: unknown = { code: "context_length_exceeded" };
      for (let i = 0; i < wrappers; i += 1) fixture = { error: fixture };
      for (const error of [fixture, `Upstream: ${JSON.stringify(fixture)}`]) {
        const body = inBand ? { type: "error", statusCode: 400, error } : { error };
        assert.equal(await collectErrorMessage({ fetch: async () => Response.json(body, { status: inBand ? 200 : 400 }) }),
          `Command Code ${inBand ? "stream error" : "request failed"} (400)${wrappers === 3 ? ": context_length_exceeded" : ""}`);
      }
    }
  }
});

test("embedded diagnostic depth, node and text budgets stop safely without raw classification", async () => {
  let deep: unknown = { code: "context_length_exceeded" };
  let wrapped: unknown = { code: "context_length_exceeded" };
  for (let i = 0; i < 8; i += 1) {
    deep = { error: deep };
    wrapped = embeddedError(wrapped);
  }
  const errors = [deep, wrapped,
    { error: [...Array.from({ length: 64 }, () => "unknown"), { code: "context_length_exceeded" }] },
    { message: "x".repeat(16 * 1024), code: "unknown", error: { code: "context_length_exceeded" } },
    // The wrapper's prose is not evidence once the embedded object parses.
    { message: 'context_length_exceeded Upstream: {"error":{"code":"unknown"}}' },
  ];
  for (const inBand of [false, true]) {
    for (const error of errors) {
      const body = inBand ? { type: "error", statusCode: 400, error } : { error };
      assert.equal(await collectErrorMessage({ fetch: async () => Response.json(body, { status: inBand ? 200 : 400 }) }),
        `Command Code ${inBand ? "stream error" : "request failed"} (400)`);
    }
  }
});

test("narrow validation phrases are recognized, generic invalid requests and non-400s are not overflow", async () => {
  for (const [message, category] of [
    ["Your input exceeds the context window of this model", "context_length_exceeded"],
    ["tool_use ids were found without tool_result blocks", "tool_pairing_or_id"],
    ["tool_call_id must match a previous call", "tool_pairing_or_id"],
    ["thinking signature is invalid", "invalid_reasoning"],
    ["max_tokens must be positive", "invalid_parameter"],
    ["invalid request", undefined],
    ["rate limit: context_length_exceeded", undefined],
  ] as const) {
    assert.equal(await collectErrorMessage({ fetch: async () => new Response(JSON.stringify({ error: { message: `${message} ${secretSentinel}` } }), { status: 400 }) }),
      `Command Code request failed (400)${category ? `: ${category}` : ""}`);
  }
  for (const status of [401, 403, 429, 500, 503]) {
    assert.equal(await collectErrorMessage({ fetch: async () => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: secretSentinel } }), { status }) }), `Command Code request failed (${status})`);
  }
});

test("quota remains terminal and transient status/network errors retain retry-recognizable messages", async () => {
  for (const inBand of [false, true]) {
    for (const status of [400, 429, 503]) {
      const error = { statusCode: status, code: "insufficient_quota", message: secretSentinel };
      const body = JSON.stringify(inBand ? { type: "error", error } : { error });
      assert.equal(await collectErrorMessage({ fetch: async () => new Response(body, { status: inBand ? 200 : status }) }), "Command Code quota exceeded");
    }
    for (const status of [429, 500, 503]) {
      const body = JSON.stringify({ type: "error", statusCode: status, error: { message: secretSentinel } });
      assert.equal(await collectErrorMessage({ fetch: async () => new Response(body, { status: inBand ? 200 : status }) }), `Command Code ${inBand ? "stream error" : "request failed"} (${status})`);
    }
  }
  assert.equal(await collectErrorMessage({ fetch: async () => { throw new Error(secretSentinel); } }), "Command Code network error");
});

test("malformed, unknown, oversized and failed diagnostic reads preserve HTTP status without raw content", async () => {
  for (const body of [secretSentinel, `<html>${secretSentinel}</html>`, `{\"error\":${secretSentinel}`, JSON.stringify({ code: secretSentinel }),
    JSON.stringify({ padding: "x".repeat(64 * 1024), error: { code: "invalid_reasoning" } })]) {
    assert.equal(await collectErrorMessage({ fetch: async () => new Response(body, { status: 400 }) }), "Command Code request failed (400)");
  }
  const prefix = '{"error":{"code":"invalid_reasoning"},"padding":"';
  const suffix = '"}';
  const exactLimit = prefix + "x".repeat(64 * 1024 - prefix.length - suffix.length) + suffix;
  assert.equal(await collectErrorMessage({ fetch: async () => new Response(exactLimit, { status: 400 }) }), "Command Code request failed (400): invalid_reasoning");
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error(secretSentinel)); } });
  assert.equal(await collectErrorMessage({ fetch: async () => new Response(body, { status: 400 }) }), "Command Code request failed (400)");
  assert.equal(body.locked, false);
  assert.equal(await collectErrorMessage({ fetch: async () => new Response(null, { status: 400 }) }), "Command Code request failed (400)");
});

test("HTTP diagnostics have a short deadline even with hanging reads and cancellation", { timeout: 4_000 }, async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel() { cancelled += 1; return new Promise(() => {}); } });
  const started = performance.now();
  assert.equal(await collectErrorMessage({ fetch: async () => new Response(body, { status: 400 }) }), "Command Code request failed (400)");
  assert.ok(performance.now() - started < 2_500);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("caller abort and overall timeout promptly clean up hanging diagnostic reads once", { timeout: 2_000 }, async () => {
  for (const callerAbort of [true, false]) {
    const controller = new AbortController();
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled += 1; return new Promise(() => {}); } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assert.equal(await collectErrorMessage({
        signal: controller.signal, timeoutMs: callerAbort ? 30_000 : 20,
        fetch: async () => {
          // A live timer also keeps Node alive for AbortSignal.timeout.
          timer = setTimeout(() => { if (callerAbort) controller.abort(); }, callerAbort ? 20 : 50);
          return new Response(body, { status: 400 });
        },
      }), callerAbort ? "Request aborted" : "Command Code request timed out");
      assert.equal(cancelled, 1);
      assert.equal(body.locked, false);
    } finally { clearTimeout(timer); }
  }
});

test("in-band validation failure stops before later terminal events and ignores unrelated diagnostic fields", async () => {
  const body = [
    { type: "error", statusCode: 400, error: { code: "invalid_reasoning", message: secretSentinel } },
    { type: "error", statusCode: 500 }, { type: "finish", finishReason: "stop" },
  ].map((event) => JSON.stringify(event)).join("\n");
  assert.equal(await collectErrorMessage({ fetch: async () => successfulResponse(body) }), "Command Code stream error (400): invalid_reasoning");
  assert.equal(await collectErrorMessage({ fetch: async () => new Response(JSON.stringify({
    error: { code: secretSentinel, path: "context_length_exceeded", headers: { error: "invalid_reasoning" }, request: { message: "invalid_parameter" } },
  }), { status: 400 }) }), "Command Code request failed (400)");
});

test("always-ready empty diagnostic chunks cannot starve the read deadline", { timeout: 4_000 }, async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array()); },
    cancel() { cancelled += 1; },
  });
  assert.equal(await collectErrorMessage({ fetch: async () => new Response(body, { status: 400 }) }), "Command Code request failed (400)");
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});
