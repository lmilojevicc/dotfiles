import assert from "node:assert/strict";
import test from "node:test";
import { COMMAND_CODE_MODELS } from "../src/catalogue.ts";
import { buildPayload, convertMessages } from "../src/protocol.ts";

const context = {
  systemPrompt: "System instructions",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reason" },
        { type: "text", text: "answer" },
        { type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "x" } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "lookup",
      content: [
        { type: "text", text: "result" },
        { type: "image", data: "ignored", mimeType: "image/png" },
      ],
      isError: false,
    },
  ],
  tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object" } }],
} as const;

test("message conversion preserves supported blocks and omits incompatible images", () => {
  assert.deepEqual(convertMessages(context), [
    {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "[Image omitted: the selected Command Code model is text-only.]" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "reason" },
        { type: "text", text: "answer" },
        { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { query: "x" } },
      ],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "lookup",
        output: { type: "text", value: "result\n[image result]" },
        isError: false,
      }],
    },
  ]);
});

test("payload projection bounds tokens and admits only valid thread IDs", () => {
  const model = COMMAND_CODE_MODELS[0];
  assert.ok(model);
  const payload = buildPayload(model, context, {
    maxTokens: Number.MAX_SAFE_INTEGER,
    reasoning: "max",
    temperature: 0.25,
    sessionId: "123e4567-e89b-42d3-a456-426614174000",
  });

  assert.equal(payload.params.max_tokens, model.maxTokens);
  assert.equal(payload.params.reasoning_effort, "max");
  assert.equal(payload.params.temperature, 0.25);
  assert.equal(payload.threadId, "123e4567-e89b-42d3-a456-426614174000");
  assert.deepEqual(payload.params.tools, [{ name: "lookup", description: "Look up a value", input_schema: { type: "object" } }]);

  const invalidSession = buildPayload(model, context, { maxTokens: 0, sessionId: "not-a-uuid" });
  assert.equal(invalidSession.params.max_tokens, 1);
  assert.equal(invalidSession.threadId, undefined);
});
