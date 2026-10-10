import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Dependencies } from "../src/index.ts";
import type { NativeConfig, Redactor } from "../src/contracts.ts";
import { offConfig } from "../src/config.ts";
import { installRedaction } from "../src/index.ts";
import { createNativeRedactor } from "../src/native.ts";
import { CENSORED } from "../src/sanitize.ts";

const messageEntry = (content: string, role = "toolResult") => ({ type: "message", message: { role, content: role === "user" ? content : [{ type: "text", text: content }], timestamp: 0 } });
const toolResult = (text: string) => ({ type: "tool_result", toolName: "custom", toolCallId: "id", input: {}, content: [{ type: "text", text }], details: undefined, isError: false });
const tools = async () => Object.fromEntries(["read", "edit", "write"].map(name => [`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`, () => ({ name, parameters: {} })])) as unknown as Awaited<ReturnType<NonNullable<Dependencies["loadTools"]>>>;

// Mock the native reservation/allocation semantics, not reverse mapping. IDs never use JS Number.
function countingRedactor() {
  const calls: string[] = [];
  let next = 0n;
  let resets = 0;
  const identities = new Map<string, string>();
  const engine: Redactor = {
    redact(text) {
      calls.push(text);
      for (const match of text.matchAll(/\[EMAIL_([0-9]+)\]/g)) {
        if (match[1].startsWith("0") || match[1].length > 20 || BigInt(match[1]) > 18446744073709551615n) throw new Error("Synthetic native reservation refusal");
        if (BigInt(match[1]) > next) next = BigInt(match[1]);
      }
      return { text: text.replace(/[a-z]+@example\.test/g, raw => {
        let token = identities.get(raw);
        if (!token) {
          if (next === 18446744073709551615n) throw new Error("Synthetic alias exhaustion");
          token = `[EMAIL_${++next}]`;
          identities.set(raw, token);
        }
        return token;
      }), matches: [] };
    },
    reset() { resets++; next = 0n; identities.clear(); },
  };
  return { engine, calls, get resets() { return resets; } };
}
async function setup(userMessages: boolean, branch: any[] = [], injected?: Redactor, literals?: Record<string, string>, flags: Partial<NativeConfig["detectors"]> = {}) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const registeredTools = new Map<string, any>();
  const config = offConfig();
  config.detectors.email = literals === undefined;
  config.literals = literals ?? {};
  Object.assign(config.detectors, flags);
  config.sources = { toolResults: true, userMessages, systemPrompt: true };
  let reads = 0;
  const manager = { getBranch() { reads++; return branch; } };
  const ctx = { cwd: "/synthetic", sessionManager: manager, ui: { notify() {} } };
  const counted = countingRedactor();
  await installRedaction({ on(name: string, handler: (...args: any[]) => any) { hooks.set(name, handler); }, registerCommand() {}, registerTool(tool: any) { registeredTools.set(tool.name, tool); } } as unknown as ExtensionAPI, {
    loadConfig: async () => ({ state: "active", path: "/synthetic/config", config }),
    createRedactor: () => injected ?? counted.engine,
    loadTools: tools,
    createFileSession: options => ({
      async read() { return { text: options.redactor.redact("fresh@example.test").text, path: "safe" }; },
      async edit() { throw new Error("unexpected single edit"); },
      async editMany() { return { text: "safe", path: "safe" }; },
      async write() { return { text: "safe", path: "safe" }; },
      async rememberPath(path) { return path; },
      reset() {},
    }),
  });
  return { hooks, registeredTools, ctx, manager, counted, config, get reads() { return reads; }, setBranch(next: any[]) { branch = next; } };
}

test("session_start reserves historical aliases before protected input, tool output and context; memoizes branch traversal", async () => {
  const h = await setup(true, [messageEntry("old [EMAIL_1]"), messageEntry("rawhistory@example.test [EMAIL_1]", "user")]);
  h.hooks.get("session_start")!({}, h.ctx);
  assert.deepEqual(h.counted.calls, ["[EMAIL_1]"], "only token strings, never complete raw history, reach native reservation");
  assert.equal(h.hooks.get("input")!({ text: "second@example.test" }, h.ctx).text, "[EMAIL_2]");
  const result = h.hooks.get("tool_result")!(toolResult("third@example.test"), h.ctx);
  assert.equal(result.content[0].text, "[EMAIL_3]");
  const context = h.hooks.get("context_with_system")!({ messages: [{ role: "system", content: "safe", timestamp: 0 }, { role: "toolResult", content: [{ type: "text", text: "[EMAIL_1]" }], timestamp: 0 }, { role: "user", content: "[EMAIL_2]", timestamp: 1 }] }, h.ctx);
  assert.equal(context.messages[1].content[0].text, "[EMAIL_1]");
  assert.equal(context.messages[2].content, "[EMAIL_2]");
  assert.equal(h.reads, 1, "do not walk the branch again for every text/details/context block");
});
test("exempt user history and new input remain raw while only token IDs are reserved", async () => {
  const raw = "intentional@example.test [EMAIL_7] [PHONE_0]";
  const entry = messageEntry(raw, "user");
  const h = await setup(false, [entry]);
  h.hooks.get("session_start")!({}, h.ctx);
  assert.deepEqual(h.counted.calls, ["[EMAIL_7]"]);
  assert.deepEqual(h.hooks.get("input")!({ text: "newintentional@example.test [EMAIL_11]" }, h.ctx), { action: "continue" });
  assert.deepEqual(h.counted.calls, ["[EMAIL_7]", "[EMAIL_11]"]);
  const result = h.hooks.get("tool_result")!(toolResult("fresh@example.test"), h.ctx);
  assert.equal(result.content[0].text, "[EMAIL_12]");
  const context = h.hooks.get("context_with_system")!({ messages: [{ role: "system", content: "safe" }, entry.message] }, h.ctx);
  assert.equal(context.messages[1], entry.message);
  assert.equal(context.messages[1].content, raw);
  assert.ok(!h.counted.calls.includes(raw));
});
test("initial allocation is guarded even when input or file execution precedes session_start", async () => {
  const input = await setup(true, [messageEntry("[EMAIL_4]")]);
  assert.equal(input.hooks.get("input")!({ text: "fresh@example.test" }, input.ctx).text, "[EMAIL_5]");
  assert.deepEqual(input.counted.calls, ["[EMAIL_4]", "fresh@example.test"]);
  const file = await setup(false, [messageEntry("[EMAIL_4]")]);
  const result = await file.registeredTools.get("read").execute("id", { path: "safe" }, undefined, undefined, file.ctx);
  assert.equal(result.content[0].text, "[EMAIL_5]");
  assert.deepEqual(file.counted.calls, ["[EMAIL_4]", "fresh@example.test"]);
});
test("tree reset reserves the newly retained branch before a new identity and does not resurrect abandoned counters", async () => {
  for (const userMessages of [true, false]) {
    const h = await setup(userMessages, [messageEntry("[EMAIL_99]")]);
    h.hooks.get("session_start")!({}, h.ctx);
    const first = h.hooks.get("tool_result")!(toolResult("first@example.test"), h.ctx);
    assert.equal(first.content[0].text, "[EMAIL_100]");
    h.setBranch([messageEntry("[EMAIL_3]", "user"), { type: "branch_summary", summary: "retained [EMAIL_19]" }, { type: "context_edit", replacement: { content: "[EMAIL_9]" } }]);
    h.hooks.get("session_tree")!({ newLeafId: "new", oldLeafId: "old" }, h.ctx);
    assert.equal(h.counted.resets, 1);
    const second = h.hooks.get("tool_result")!(toolResult("second@example.test"), h.ctx);
    assert.equal(second.content[0].text, "[EMAIL_20]");
    assert.equal(h.reads, 2);
  }
});
test("sparse large IDs retain exact decimal identity; disabled categories and opaque data never activate detectors", async () => {
  const h = await setup(true, [messageEntry("[EMAIL_9007199254740993] [EMAIL_2] [PHONE_01] [API_TOKEN_18446744073709551616]"), { type: "compaction", summary: "[EMAIL_7]", systemMessage: { role: "system", content: "[EMAIL_8]" } }, { type: "message", message: { role: "user", content: [{ type: "image", data: "[EMAIL_999999999999999999999]" }, { type: "text", text: "safe", textSignature: "[EMAIL_999999999999999999999]" }] } }]);
  h.hooks.get("session_start")!({}, h.ctx);
  assert.deepEqual(h.counted.calls, ["[EMAIL_9007199254740993]", "[EMAIL_2]", "[EMAIL_7]", "[EMAIL_8]"]);
  assert.equal(h.hooks.get("input")!({ text: "fresh@example.test" }, h.ctx).text, "[EMAIL_9007199254740994]");
});
test("all enabled alias families are extracted from retained text, custom messages and argument values without decoding signatures", async () => {
  const h = await setup(true, [messageEntry("[EMAIL_7]"), { type: "message", message: { role: "assistant", content: [{ type: "toolCall", arguments: { data: "[API_TOKEN_17]" } }, { type: "thinking", thinking: "[PRIVATE_KEY_9]", thinkingSignature: "[EMAIL_999]" }] } }, { type: "custom_message", content: "[CREDENTIAL_URL_3]" }, { type: "branch_summary", summary: "[PHONE_4]" }], undefined, undefined, { phone: true, apiToken: true, privateKey: true, credentialUrl: true });
  h.hooks.get("session_start")!({}, h.ctx);
  assert.deepEqual(h.counted.calls, ["[EMAIL_7]", "[API_TOKEN_17]", "[PRIVATE_KEY_9]", "[CREDENTIAL_URL_3]", "[PHONE_4]"]);
});
test("a replaced session manager triggers reservation even before another session_start hook", async () => {
  const h = await setup(true, [messageEntry("[EMAIL_1]")]);
  h.hooks.get("session_start")!({}, h.ctx);
  const nextContext = { ...h.ctx, sessionManager: { getBranch: () => [messageEntry("[EMAIL_8]")] } };
  assert.equal(h.hooks.get("input")!({ text: "fresh@example.test" }, nextContext).text, "[EMAIL_9]");
  assert.deepEqual(h.counted.calls, ["[EMAIL_1]", "[EMAIL_8]", "fresh@example.test"]);
});
test("missing/throwing history, malformed reservations and exhausted IDs latch failure without changing exempt user input", async () => {
  for (const userMessages of [true, false]) {
    for (const failure of ["missing", "throwing", "malformed", "exhausted", "budget"] as const) {
      const branch = failure === "malformed" ? [messageEntry("[EMAIL_01]")] : failure === "exhausted" ? [messageEntry("[EMAIL_18446744073709551615]")] : failure === "budget" ? new Array(100001).fill(messageEntry("safe")) : [];
      const h = await setup(userMessages, branch);
      if (failure === "throwing") h.manager.getBranch = () => { throw new Error("synthetic raw error"); };
      const ctx = failure === "missing" ? { ...h.ctx, sessionManager: undefined } : h.ctx;
      assert.doesNotThrow(() => h.hooks.get("session_start")!({}, ctx));
      const input = h.hooks.get("input")!({ text: "fresh@example.test" }, ctx);
      // Exhaustion fails only on new allocation, so allocate through protected output for exempt input.
      const result = h.hooks.get("tool_result")!(toolResult("fresh@example.test"), ctx);
      assert.equal(result.content[0].text, CENSORED);
      assert.equal(input.action, userMessages ? "transform" : "continue");
      if (userMessages) assert.equal(input.text, CENSORED);
      const user = { role: "user", content: "intentional@example.test", timestamp: 0 };
      const context = h.hooks.get("context_with_system")!({ messages: [{ role: "system", content: "protected@example.test" }, user] }, ctx);
      assert.ok(!JSON.stringify(context).includes("protected@example.test"));
      assert.equal(context.messages.includes(user), !userMessages);
      assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: { raw: "fresh@example.test" } }), {});
    }
  }
});
test("tree reset failure cannot allocate new aliases or escape via swallowed lifecycle errors", async () => {
  const h = await setup(true, [messageEntry("[EMAIL_1]")]);
  h.hooks.get("session_start")!({}, h.ctx);
  h.setBranch([messageEntry("[EMAIL_18446744073709551616]")]);
  assert.doesNotThrow(() => h.hooks.get("session_tree")!({}, h.ctx));
  assert.equal(h.hooks.get("input")!({ text: "fresh@example.test" }, h.ctx).text, CENSORED);
  assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: {} }), {});
});
test("native reset failure is latched before history reservation or new allocation", async () => {
  const engine = countingRedactor();
  const h = await setup(true, [messageEntry("[EMAIL_1]")], { redact: text => engine.engine.redact(text), reset() { throw new Error("synthetic private reset failure"); } });
  h.hooks.get("session_start")!({}, h.ctx);
  assert.equal(h.hooks.get("input")!({ text: "first@example.test" }, h.ctx).text, "[EMAIL_2]");
  assert.doesNotThrow(() => h.hooks.get("session_tree")!({}, h.ctx));
  assert.equal(h.hooks.get("input")!({ text: "second@example.test" }, h.ctx).text, CENSORED);
  assert.deepEqual(engine.calls, ["[EMAIL_1]", "first@example.test"]);
  assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: {} }), {});
});
test("paired V1 no-match history scans reserve IDs before text-only allocation and preserve the user exception", async () => {
  let next = 0n;
  const calls: string[] = [];
  const native = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
    redact(): string { throw new Error("no legacy JSON allowed"); }
    redactSpansUtf16V1(value: string) {
      calls.push(`spans:${value}`);
      const id = /^\[EMAIL_([1-9][0-9]*)\]$/.exec(value)?.[1];
      if (!id) throw new Error("mock history must contain tokens only");
      if (BigInt(id) > next) next = BigInt(id);
      return null; // Completed successful reservation, not a scan bypass.
    }
    redactTextV1(value: string) {
      calls.push(`text:${value}`);
      return value === "fresh@example.test" ? `[EMAIL_${++next}]` : null;
    }
    reset() { next = 0n; }
  } }));
  const h = await setup(false, [messageEntry("retained@example.test [EMAIL_9]", "user")], native);
  h.hooks.get("session_start")!({}, h.ctx);
  assert.deepEqual(calls, ["spans:[EMAIL_9]"]);
  assert.deepEqual(h.hooks.get("input")!({ text: "intentional@example.test [EMAIL_15]" }, h.ctx), { action: "continue" });
  const result = h.hooks.get("tool_result")!(toolResult("fresh@example.test"), h.ctx);
  assert.equal(result.content[0].text, "[EMAIL_16]");
  assert.deepEqual(calls, ["spans:[EMAIL_9]", "spans:[EMAIL_15]", "text:fresh@example.test"]);
  assert.equal(h.reads, 1);
  h.setBranch([messageEntry("[EMAIL_30]")]);
  h.hooks.get("session_tree")!({}, h.ctx);
  assert.equal(h.hooks.get("tool_result")!(toolResult("fresh@example.test"), h.ctx).content[0].text, "[EMAIL_31]");
  assert.deepEqual(calls.slice(-2), ["spans:[EMAIL_30]", "text:fresh@example.test"]);
});

test("overlapping literal/alias native refusal censors registered result/context and latches request failure", async () => {
  for (const fast of [false, true]) for (const firstHook of ["tool_result", "context_with_system"] as const) {
    const filter = (text: string) => { if (text.includes("secretMASK")) throw new Error("secret->cretMASK overlap: secretMASK"); return text; };
    const h = await setup(true, [], { redact(text) { return { text: filter(text), matches: [] }; }, ...(fast ? { redactText: filter } : {}), reset() {} }, { secret: "cretMASK" });
    const event = firstHook === "tool_result" ? toolResult("secretMASK") : { messages: [{ role: "system", content: "safe" }, { role: "toolResult", content: [{ type: "text", text: "secretMASK" }] }] };
    const first = h.hooks.get(firstHook)!(event, h.ctx);
    assert.ok(!JSON.stringify(first).includes("secret"));
    const result = h.hooks.get("tool_result")!(toolResult("secretMASK"), h.ctx);
    assert.equal(result.content[0].text, CENSORED);
    const context = h.hooks.get("context_with_system")!({ messages: [{ role: "system", content: "secretMASK" }, { role: "user", content: "secretMASK" }] }, h.ctx);
    assert.ok(!JSON.stringify(context).includes("secret"));
    assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: { raw: "secretMASK" } }), {});
  }
});
