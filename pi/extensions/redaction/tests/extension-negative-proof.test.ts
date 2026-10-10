import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Dependencies } from "../src/index.ts";
import type { NativeModule } from "../src/native.ts";
import { createNativeRedactor } from "../src/native.ts";
import { installRedaction } from "../src/index.ts";
import { offConfig } from "../src/config.ts";
import { CENSORED } from "../src/sanitize.ts";

const event = (fields: object = {}) => ({ type: "tool_result", toolName: "synthetic", toolCallId: "id", input: {}, content: [{ type: "text", text: "safe" }], details: undefined, isError: false, ...fields }) as ToolResultEvent;
async function setup(options: { proof?: () => unknown; branch?: any[] } = {}) {
  const hooks = new Map<string, (...args: any[]) => any>();
  const calls = { constructors: 0, proofs: 0, resets: 0, spans: [] as string[], text: [] as string[] };
  const config = offConfig(); config.detectors.email = true;
  config.sources = { toolResults: true, userMessages: false, systemPrompt: true };
  let branch = options.branch ?? [];
  const ctx = { cwd: "/synthetic", sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
  // Explicit ABI/reservation mock, not a native detector implementation or benchmark.
  class Engine {
    next = 0n;
    identities = new Map<string, string>();
    constructor(json: string) { calls.constructors++; assert.deepEqual(JSON.parse(json).literals, {}); }
    negativeProofAsciiV1() { calls.proofs++; return options.proof ? options.proof() : "[@"; }
    redact(): string { assert.fail("no legacy fallback"); }
    reserve(value: string) {
      for (const match of value.matchAll(/\[EMAIL_([0-9]+)\]/g)) {
        if (match[1].startsWith("0") || match[1].length > 20 || BigInt(match[1]) > 18446744073709551615n) throw new Error("synthetic ID refusal");
        if (BigInt(match[1]) > this.next) this.next = BigInt(match[1]);
      }
    }
    redactSpansUtf16V1(value: string) { calls.spans.push(value); this.reserve(value); return null; }
    redactTextV1(value: string) {
      calls.text.push(value); this.reserve(value);
      let output = value;
      for (const raw of ["arden@example.test", "river@example.test", "third@example.test"]) {
        if (!output.includes(raw)) continue;
        let alias = this.identities.get(raw);
        if (!alias) { alias = `[EMAIL_${++this.next}]`; this.identities.set(raw, alias); }
        output = output.replaceAll(raw, alias);
      }
      return output === value ? null : output;
    }
    reset() { calls.resets++; this.next = 0n; this.identities.clear(); }
  }
  await installRedaction({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI, {
    loadConfig: async () => ({ state: "active", config, path: "/synthetic/policy.json" }),
    createRedactor: config => createNativeRedactor(config, () => ({ NativeRedactor: Engine }) as unknown as NativeModule),
    createFileSession() { throw new Error("no file operations"); },
    loadTools: async () => Object.fromEntries(["read", "edit", "write"].map(name => [`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`, () => ({ name, parameters: {} })])) as unknown as Awaited<ReturnType<NonNullable<Dependencies["loadTools"]>>>,
  });
  return { hooks, ctx, calls, setBranch(value: any[]) { branch = value; } };
}

test("certified short fields retain complete nested/key cloning and reserve history before marker scans", async () => {
  const historical = { type: "message", message: { role: "user", content: "[EMAIL_7] intentional@example.test" } };
  const h = await setup({ branch: [historical] });
  const benign = event({ content: ["safe", "plain", "clean", "ok"].map(text => ({ type: "text", text })), details: { status: "ok", nested: [{ label: "ordinary", extra: "plain" }] }, structuredContent: { rows: [{ note: "clean" }] } });
  const result = h.hooks.get("tool_result")!(benign, h.ctx);
  assert.deepEqual(result.content, benign.content);
  assert.notEqual(result.content, benign.content);
  assert.notEqual(result.details, benign.details);
  assert.notEqual(result.details.nested[0], (benign.details as any).nested[0]);
  assert.notEqual(result.structuredContent.rows, (benign.structuredContent as any).rows);
  assert.equal(Object.getPrototypeOf(result.details), null);
  assert.deepEqual(h.calls.spans, ["[EMAIL_7]"], "only token substrings from exempt raw history reach native");
  assert.deepEqual(h.calls.text, [], "all benign values AND keys certified, not omitted");
  const sensitive = event({ content: [{ type: "text", text: "arden@example.test" }], details: { "river@example.test": { value: "third@example.test" } }, structuredContent: ["plain", "arden@example.test"], isError: true });
  const masked = h.hooks.get("tool_result")!(sensitive, h.ctx);
  assert.equal(masked.content[0].text, "[EMAIL_8]");
  assert.equal(masked.details["[EMAIL_9]"].value, "[EMAIL_10]");
  assert.equal(masked.structuredContent[1], "[EMAIL_8]");
  assert.equal(masked.isError, true);
  for (const raw of ["arden@example.test", "river@example.test", "third@example.test"]) assert.ok(!JSON.stringify(masked).includes(raw));
  assert.equal((sensitive.details as any)["river@example.test"].value, "third@example.test");
  assert.deepEqual(h.hooks.get("input")!({ text: "intentionally@example.test" }, h.ctx), { action: "continue" });
  const direct = { role: "user", content: "intentionally@example.test" };
  assert.equal(h.hooks.get("context_with_system")!({ messages: [direct] }, h.ctx).messages[0], direct);
  h.setBranch([{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "[EMAIL_20]" }] } }]);
  h.hooks.get("session_tree")!({}, h.ctx);
  assert.equal(h.hooks.get("tool_result")!(event({ content: [{ type: "text", text: "arden@example.test" }] }), h.ctx).content[0].text, "[EMAIL_21]");
  assert.equal(h.calls.proofs, 1, "compiled rules and descriptor survive identity reset");
  assert.deepEqual(h.calls.spans, ["[EMAIL_7]", "[EMAIL_20]"]);
});

test("invalid descriptors latch active-hook censorship; clean proof candidates cannot bypass failure", async () => {
  for (const proof of [() => undefined, () => "^", () => "[".repeat(18), () => { throw new Error("synthetic private descriptor detail"); }]) {
    const h = await setup({ proof });
    const first = h.hooks.get("tool_result")!(event({ details: { clean: "plain" }, structuredContent: ["safe"] }), h.ctx);
    assert.equal(first.content[0].text, CENSORED);
    assert.equal(first.details, null);
    assert.equal(first.structuredContent, null);
    assert.equal(h.calls.proofs, 1);
    assert.deepEqual(h.calls.text, []);
    assert.equal(h.hooks.get("tool_result")!(event(), h.ctx).content[0].text, CENSORED);
    assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: { raw: "private" } }, h.ctx), {});
    assert.equal(h.calls.proofs, 1);
  }
});

test("proof candidates still respect history, malformed-ID/Unicode, object and binary policies", async () => {
  const missing = await setup();
  assert.equal(missing.hooks.get("tool_result")!(event(), { ...missing.ctx, sessionManager: undefined }).content[0].text, CENSORED);
  assert.equal(missing.calls.constructors, 0);
  const binary = await setup();
  const withheld = binary.hooks.get("tool_result")!(event({ details: { DaTa: { raw: "arden@example.test" } } }), binary.ctx);
  assert.ok(!JSON.stringify(withheld).includes("arden@example.test"));
  assert.deepEqual(binary.calls.text, []);
  const cycle: any = {}; cycle.next = cycle;
  for (const fields of [{ content: [{ type: "text", text: "[EMAIL_01]" }] }, { details: { clean: "\ud800" } }, { details: cycle }, { structuredContent: new Date(0) }, { details: { "arden@example.test": "clean", "[EMAIL_1]": "plain" } }]) {
    const h = await setup();
    assert.equal(h.hooks.get("tool_result")!(event(fields), h.ctx).content[0].text, CENSORED);
    assert.equal(h.hooks.get("tool_result")!(event(), h.ctx).content[0].text, CENSORED);
    assert.deepEqual(h.hooks.get("before_provider_request")!({}, h.ctx), {});
  }
});
