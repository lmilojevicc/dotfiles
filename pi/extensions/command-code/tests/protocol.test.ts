import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { buildPayload, convertMessages } from "../src/protocol.ts";
import { assistant, call, handoff, nextUser, result, sameTarget, target } from "./history-fixtures.ts";

// Wire assertions deliberately observe only JSON projected by this provider.
type WireMessage = { role: string; content: { type: string; text?: string; toolCallId?: string; isError?: boolean; output?: { value: string } }[] };
function wire(context: Context): WireMessage[] {
  return JSON.parse(JSON.stringify(convertMessages(context, target))) as WireMessage[];
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
}

test("source text control survives target-aware projection without mutation", () => {
  const context: Context = { messages: [nextUser, assistant([{ type: "text", text: "synthetic answer" }]), nextUser] };
  const snapshot = structuredClone(context);
  freeze(context);
  assert.deepEqual(wire(context), [
    { role: "user", content: [{ type: "text", text: "synthetic next" }] },
    { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] },
    { role: "user", content: [{ type: "text", text: "synthetic next" }] },
  ]);
  assert.deepEqual(context, snapshot);
});

test("foreign thinking becomes text and composite tool IDs remain paired through the compatibility adapter", () => {
  const context = handoff();
  const snapshot = structuredClone(context);
  freeze(context);
  const messages = wire(context);
  assert.deepEqual(messages[1].content[0], { type: "text", text: "synthetic reasoning" });
  const id = messages[1].content[1].toolCallId;
  assert.match(id!, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(messages[2].content[0].toolCallId, id);
  const serialized = JSON.stringify(messages);
  for (const sentinel of ["SIGNATURE_SENTINEL", "NAMESPACE_SENTINEL", "openai-codex", "fc_synthetic"]) assert.equal(serialized.includes(sentinel), false);
  assert.deepEqual(wire(context), messages);
  assert.deepEqual(context, snapshot);
  const nonReasoning = { ...target, reasoning: false };
  assert.deepEqual(convertMessages(context, nonReasoning), messages);
});

test("same-target reasoning and valid tool IDs survive; all three identity fields matter", () => {
  const content = [{ type: "thinking" as const, thinking: "reason" }, call("valid_call-1")];
  const source = sameTarget(content);
  const context: Context = { messages: [source, result("valid_call-1")] };
  assert.deepEqual(wire(context)[0].content[0], { type: "reasoning", text: "reason" });
  assert.equal(wire(context)[0].content[1].toolCallId, "valid_call-1");
  assert.equal(wire(context)[1].content[0].toolCallId, "valid_call-1");
  for (const field of ["provider", "api", "model"] as const) {
    const changed: Context = { messages: [{ ...source, [field]: "different" }, result("valid_call-1")] };
    assert.equal(wire(changed)[0].content[0].type, "text");
    assert.notEqual(wire(changed)[0].content[1].toolCallId, "valid_call-1");
  }
});

test("encrypted, redacted and blank thinking do not create empty assistants or leak opaque contents", () => {
  const blocks = [
    { type: "thinking" as const, thinking: "", thinkingSignature: "SECRET_ENCRYPTED" },
    { type: "thinking" as const, thinking: "  " },
    { type: "thinking" as const, thinking: "SECRET_REDACTED", redacted: true, thinkingSignature: "SECRET_ENCRYPTED" },
    { type: "text" as const, text: "" },
  ];
  for (const make of [assistant, sameTarget]) {
    assert.deepEqual(wire({ messages: [make(blocks), nextUser] }), wire({ messages: [nextUser] }));
    assert.deepEqual(wire({ messages: [make([...blocks, { type: "text", text: "visible" }])] }), [
      { role: "assistant", content: [{ type: "text", text: "visible" }] },
    ]);
  }
});

test("failed/aborted calls and their results, standalone orphans and duplicates are discarded", () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const context: Context = { messages: [
      assistant([call("failed"), { type: "thinking", thinking: "partial" }], { stopReason }),
      result("failed", "DISCARDED_FAILED"), result("orphan", "DISCARDED_ORPHAN"),
      assistant([], { stopReason }), assistant([call("ok")], { stopReason: "toolUse" }),
      result("ok"), result("ok", "DISCARDED_DUPLICATE"), nextUser, result("ok", "DISCARDED_LATE"),
    ] };
    const messages = wire(context);
    assert.deepEqual(messages.map((m) => m.role), ["assistant", "tool", "user"]);
    assert.equal(JSON.stringify(messages).includes("DISCARDED"), false);
    assert.equal(messages[0].content[0].toolCallId, messages[1].content[0].toolCallId);
  }
});

test("compatibility adapter synthesizes exactly one missing error result before user/assistant boundaries and at EOF", () => {
  for (const boundary of [[], [nextUser], [assistant([{ type: "text", text: "next" }])]]) {
    const context: Context = { messages: [assistant([call("a"), call("b")], { stopReason: "toolUse" }), result("b"), result("b"), ...boundary] };
    const messages = wire(context);
    assert.deepEqual(messages.slice(0, 3).map((m) => m.role), ["assistant", "tool", "tool"]);
    assert.equal(messages[0].content[1].toolCallId, messages[1].content[0].toolCallId);
    assert.equal(messages[0].content[0].toolCallId, messages[2].content[0].toolCallId);
    assert.equal(messages[2].content[0].isError, true);
    assert.equal(messages[2].content[0].output?.value, "No result provided");
  }
});

test("foreign unsafe/long/naively colliding IDs get distinct deterministic bounded mappings", () => {
  const ids = ["|", "!", "a|b", "a?b", "x".repeat(500) + "a", "x".repeat(500) + "b", "safe"];
  const context: Context = { messages: [assistant(ids.map((id) => call(id)), { stopReason: "toolUse" }), ...ids.map((id) => result(id))] };
  const snapshot = structuredClone(context);
  freeze(context);
  const messages = wire(context);
  const mapped = messages[0].content.map((part) => part.toolCallId);
  assert.equal(new Set(mapped).size, ids.length);
  mapped.forEach((id, i) => {
    assert.match(id!, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(messages[i + 1].content[0].toolCallId, id);
  });
  assert.deepEqual(wire(context), messages);
  assert.deepEqual(context, snapshot);
});

test("compatibility adapter downgrades unsupported user/tool images while retaining supported images", () => {
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  const context: Context = { messages: [
    { role: "user", content: [image], timestamp: 1 }, sameTarget([call("image")]), { ...result("image"), content: [image] },
  ] };
  assert.equal(wire(context)[0].content[0].text, "(image omitted: model does not support images)");
  assert.equal(wire(context)[2].content[0].output?.value, "(tool image omitted: model does not support images)");
  assert.match(JSON.stringify(convertMessages(context, { ...target, input: ["text", "image"] })), /data:image\/png;base64,aW1hZ2U=/);
});

test("payload projection bounds tokens and admits only valid thread IDs", () => {
  const context = handoff();
  const payload = buildPayload(target, context, { maxTokens: Number.MAX_SAFE_INTEGER, reasoning: "max", temperature: 0.25, sessionId: "123e4567-e89b-42d3-a456-426614174000" });
  assert.equal(payload.params.max_tokens, target.maxTokens);
  assert.equal(payload.params.reasoning_effort, "max");
  assert.equal(payload.params.temperature, 0.25);
  assert.equal(payload.threadId, "123e4567-e89b-42d3-a456-426614174000");
  const invalidSession = buildPayload(target, context, { maxTokens: 0, sessionId: "not-a-uuid" });
  assert.equal(invalidSession.params.max_tokens, 1);
  assert.equal(invalidSession.threadId, undefined);
});
