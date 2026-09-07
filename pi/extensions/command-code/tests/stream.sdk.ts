import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { buildPayload } from "../src/protocol.ts";
import { COMMAND_CODE_MODELS } from "../src/catalogue.ts";
import { streamCommandCode } from "../src/stream.ts";
import { handoff, target } from "./history-fixtures.ts";
import { embeddedError, forbiddenFieldErrors, opaqueEmbeddedErrors, recognizedEmbeddedErrors } from "./diagnostic-fixtures.ts";
// These error regressions also run with the actual SDK EventStream, not a stub.
import "./stream.test.ts";

test("actual stream request boundary sends normalized immutable foreign history", async () => {
  const context = handoff();
  context.tools = [{ name: "lookup", description: "Synthetic lookup", parameters: Type.Object({ query: Type.String() }) }];
  const model = COMMAND_CODE_MODELS.find((model) => model.id === "meta/muse-spark-1.3-contributor");
  assert.ok(model);
  const snapshot = structuredClone(context);
  let requests = 0;
  const stream = streamCommandCode(model, context, {
    apiKey: "SYNTHETIC_CREDENTIAL", maxTokens: 1024, reasoning: "low",
    fetch: async (url, init) => {
      requests += 1;
      assert.equal(url, "https://api.commandcode.ai/alpha/generate");
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.params.messages, buildPayload(model, context).params.messages);
      assert.equal(body.params.messages[1].content[0].type, "text");
      assert.match(body.params.messages[1].content[1].toolCallId, /^[A-Za-z0-9_-]{1,64}$/);
      assert.equal(body.params.messages[2].content[0].toolCallId, body.params.messages[1].content[1].toolCallId);
      assert.equal(String(init?.body).includes("SIGNATURE_SENTINEL"), false);
      assert.deepEqual(body.params.tools, [{ name: "lookup", description: "Synthetic lookup", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }]);
      assert.equal(body.params.max_tokens, 1024);
      assert.equal(body.params.reasoning_effort, "low");
      return new Response('{"type":"text-delta","text":"synthetic"}\n{"type":"finish","finishReason":"stop"}\n');
    },
  });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.filter((e) => e.type === "done").length, 1);
  assert.equal(events.filter((e) => e.type === "error").length, 0);
  assert.equal(requests, 1);
  assert.deepEqual(context, snapshot);
});

test("real Pi overflow recognizer accepts only the known normalized context category", async () => {
  for (const inBand of [false, true]) {
    for (const code of ["context_length_exceeded", "invalid_tool_call_id", "invalid_reasoning", "invalid_parameter", "unknown"]) {
      const error = { statusCode: 400, code, message: "SECRET_SENTINEL" };
      const stream = streamCommandCode(target, { messages: [] }, {
        apiKey: "SYNTHETIC_CREDENTIAL",
        fetch: async () => new Response(JSON.stringify(inBand ? { type: "error", error } : { error }), { status: inBand ? 200 : 400 }),
      });
      const message = await stream.result();
      assert.equal(message.stopReason, "error");
      assert.equal(isContextOverflow(message), code === "context_length_exceeded");
      assert.equal(message.errorMessage?.includes("SECRET_SENTINEL"), false);
    }
  }
});

test("real Pi overflow ignores embedded forbidden fields and accepts recognized plain and embedded signals only", async () => {
  for (const inBand of [false, true]) {
    const cases: [unknown, string | undefined][] = [
      ...forbiddenFieldErrors.flatMap((error): [unknown, undefined][] => [[error, undefined], [embeddedError(error), undefined]]),
      ...recognizedEmbeddedErrors.flatMap(([error, category]): [unknown, string][] => [[error, category], [embeddedError(error), category]]),
    ];
    for (const [error, category] of cases) {
      const body = inBand ? { type: "error", statusCode: 400, error } : { error };
      const message = await streamCommandCode(target, { messages: [] }, {
        apiKey: "SYNTHETIC_CREDENTIAL",
        fetch: async () => Response.json(body, { status: inBand ? 200 : 400 }),
      }).result();
      assert.equal(isContextOverflow(message), category === "context_length_exceeded");
      assert.equal(message.errorMessage, category === "quota" ? "Command Code quota exceeded"
        : `Command Code ${inBand ? "stream error" : "request failed"} (400)${category ? `: ${category}` : ""}`);
    }
  }
});

for (const [name, error] of opaqueEmbeddedErrors) {
  test(`real Pi overflow ignores opaque embedded diagnostics: ${name}`, async () => {
    for (const inBand of [false, true]) {
      const body = inBand ? { type: "error", statusCode: 400, error } : { error };
      const message = await streamCommandCode(target, { messages: [] }, {
        apiKey: "SYNTHETIC_CREDENTIAL",
        fetch: async () => Response.json(body, { status: inBand ? 200 : 400 }),
      }).result();
      assert.equal(message.stopReason, "error");
      assert.equal(isContextOverflow(message), false, inBand ? "in-band" : "HTTP");
      assert.equal(message.errorMessage, `Command Code ${inBand ? "stream error" : "request failed"} (400)`);
    }
  });
}

test("real Pi retry recognition retains transient, quota and auth semantics", async () => {
  const { isRetryableAssistantError } = await import("@earendil-works/pi-ai/utils/retry");
  for (const inBand of [false, true]) {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      for (const quota of [false, true]) {
        const error = { statusCode: status, code: quota ? "insufficient_quota" : "unknown", message: "SECRET_SENTINEL" };
        const stream = streamCommandCode(target, { messages: [] }, {
          apiKey: "SYNTHETIC_CREDENTIAL",
          fetch: async () => new Response(JSON.stringify(inBand ? { type: "error", error } : { error }), { status: inBand ? 200 : status }),
        });
        const message = await stream.result();
        assert.equal(isRetryableAssistantError(message), !quota && [429, 500, 503].includes(status));
        assert.equal(isContextOverflow(message), false);
      }
    }
  }
});
