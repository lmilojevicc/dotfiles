import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Dependencies } from "../src/index.ts";
import type { NativeModule } from "../src/native.ts";
import type { RedactionResult } from "../src/contracts.ts";
import { createNativeRedactor, convertNativeResult } from "../src/native.ts";
import { validateConfig } from "../src/config.ts";
import { installRedaction } from "../src/index.ts";
import { BINARY_WITHHELD, CENSORED } from "../src/sanitize.ts";

// Actual bundled addon throughout; only Pi's registration/schema factory is synthetic.
const { NativeRedactor } = createRequire(import.meta.url)("../native/redaction.node") as NativeModule;
const unavailable = { message: "Redaction engine unavailable" };
const nativeRefusal = { message: "Redaction configuration or operation is invalid" };
const all = validateConfig({ literals: { hidden: "PRIVATE_LITERAL" }, detectors: {
  email: true, phone: true, apiToken: true, privateKey: true, credentialUrl: true,
} });
const fresh = (policy = all) => new NativeRedactor(JSON.stringify({ literals: policy.literals, detectors: policy.detectors }));
const routes = ["redact", "redactTextV1", "redactSpansUtf16V1"] as const;
const wellFormed = (value: string) => (value as string & { isWellFormed(): boolean }).isWellFormed();

function instrument() {
  const prototype = NativeRedactor.prototype;
  const originals = new Map(routes.map(name => [name, prototype[name]]));
  const certificate = prototype.negativeProofAsciiV1;
  let proofs = 0;
  if (certificate) prototype.negativeProofAsciiV1 = function () { proofs++; return certificate.call(this); };
  const calls = { legacy: 0, text: 0, spans: 0 };
  const observed: Array<{ input: string; result: RedactionResult | null }> = [];
  prototype.redact = () => { calls.legacy++; throw new Error("V1 must not fall back to JSON"); };
  prototype.redactTextV1 = function (input: string) {
    calls.text++;
    return originals.get("redactTextV1")!.call(this, input) as string | null;
  };
  prototype.redactSpansUtf16V1 = function (input: string) {
    calls.spans++;
    const result = originals.get("redactSpansUtf16V1")!.call(this, input) as RedactionResult | null;
    observed.push({ input, result });
    return result;
  };
  return { calls, observed, get proofs() { return proofs; }, restore() {
    for (const name of routes) Object.defineProperty(prototype, name, { value: originals.get(name), writable: true, configurable: true, enumerable: true });
    if (certificate) prototype.negativeProofAsciiV1 = certificate;
  } };
}

function host() {
  const hooks = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {} } as unknown as ExtensionAPI;
  return { pi, hooks, tools };
}
const loadTools: NonNullable<Dependencies["loadTools"]> = async () => ({
  createReadToolDefinition: () => ({ name: "read", parameters: { type: "object" } }),
  createEditToolDefinition: () => ({ name: "edit", parameters: { type: "object" } }),
  createWriteToolDefinition: () => ({ name: "write", parameters: { type: "object" } }),
}) as unknown as Awaited<ReturnType<NonNullable<Dependencies["loadTools"]>>>;

test("integration V1: actual native null/text/UTF16/legacy and production bridge parity", () => {
  const engines = routes.map(() => fresh());
  const bridgeSpans = createNativeRedactor(all), bridgeText = createNativeRedactor(all);
  for (const input of ["", "clean ASCII", "🙂e\u0301 名 \ufffd\0", "🙂[EMAIL_40] [PHONE_80]",
    "hidden", "🙂é a@b.co 名 1234567", "sk-abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----",
    "https://user:pass@example.org/x", "🙂hidden a@b.co 1234567 尾", "a@b.co ".repeat(512)]) {
    const expected = convertNativeResult(input, engines[0].redact(input));
    assert.equal(engines[1].redactTextV1!(input), expected.matches.length ? expected.text : null);
    assert.deepEqual(engines[2].redactSpansUtf16V1!(input), expected.matches.length ? expected : null);
    assert.deepEqual(bridgeSpans.redact(input), expected);
    assert.equal(bridgeText.redactText!(input), expected.text);
    for (const match of expected.matches) {
      assert.ok(wellFormed(input.slice(0, match.start)));
      assert.ok(wellFormed(input.slice(match.start, match.end)));
    }
  }
  engines.forEach(engine => engine.reset());
  bridgeSpans.reset(); bridgeText.reset();
  const input = "🙂a@b.co";
  assert.deepEqual(bridgeSpans.redact(input), { text: "🙂[EMAIL_1]", matches: [{ start: 2, end: 8, replacement: "[EMAIL_1]", kind: "email" }] });
  assert.equal(bridgeText.redactText!(input), "🙂[EMAIL_1]");
});

test("integration V1: no-change scans reserve exact large IDs for subsequent allocations", () => {
  const policy = validateConfig({ detectors: { email: true } });
  for (const route of routes) {
    const engine = fresh(policy);
    const unchanged = engine[route]!("🙂[EMAIL_9007199254740993]");
    if (route === "redact") assert.equal(JSON.parse(unchanged as string).matches.length, 0);
    else assert.equal(unchanged, null);
    const changed = engine[route]!("a@b.co");
    assert.equal(route === "redact" ? JSON.parse(changed as string).text : route === "redactTextV1" ? changed : (changed as RedactionResult).text, "[EMAIL_9007199254740994]");
  }
  for (const route of ["redact", "redactText"] as const) {
    const bridge = createNativeRedactor(policy);
    const input = "🙂[EMAIL_9007199254740993]";
    assert.deepEqual(bridge[route]!(input), route === "redact" ? { text: input, matches: [] } : input);
    const changed = bridge[route]!("a@b.co");
    assert.equal(typeof changed === "string" ? changed : changed.text, "[EMAIL_9007199254740994]");
  }
});

test("integration V1: actual direct/native and bridge surrogate refusals precede state mutation", () => {
  const policy = validateConfig({ detectors: { email: true } });
  const engines = routes.map(() => fresh(policy));
  const bridge = createNativeRedactor(policy);
  bridge.redactText!("initialize");
  for (let unit = 0xd800; unit <= 0xdfff; unit++) {
    const input = `[EMAIL_999]🙂${String.fromCharCode(unit)}\ufffd`;
    engines.forEach((engine, i) => assert.throws(() => engine[routes[i]]!(input), nativeRefusal));
  }
  const tracking = instrument();
  try {
    for (let unit = 0xd800; unit <= 0xdfff; unit++) {
      const input = `[EMAIL_999]🙂${String.fromCharCode(unit)}\ufffd`;
      assert.throws(() => bridge.redact(input), unavailable);
      assert.throws(() => bridge.redactText!(input), unavailable);
    }
    assert.deepEqual(tracking.calls, { legacy: 0, text: 0, spans: 0 }, "malformed bridge calls never dispatch");
  } finally { tracking.restore(); }
  for (const [i, engine] of engines.entries()) {
    assert.throws(() => engine[routes[i]]!("[EMAIL_999]\ud800"), nativeRefusal);
    const result = engine[routes[i]]!("a@b.co");
    assert.equal(i === 0 ? JSON.parse(result as string).text : i === 1 ? result : (result as RedactionResult).text, "[EMAIL_1]");
  }
  assert.equal(bridge.redactText!("a@b.co"), "[EMAIL_1]");
  assert.equal(bridge.redactText!("🙂\ufffd\0"), "🙂\ufffd\0");
});

test("integration V1: actual native alias-boundary refusal preserves transactional identities", () => {
  const policy = validateConfig({ literals: { "]!x": "MASKED" }, detectors: { email: true } });
  for (const route of routes) {
    const engine = fresh(policy);
    assert.throws(() => engine[route]!("a@b.co!x"), nativeRefusal);
    const result = engine[route]!("c@d.co");
    assert.equal(route === "redact" ? JSON.parse(result as string).text : route === "redactTextV1" ? result : (result as RedactionResult).text, "[EMAIL_1]");
  }
  for (const route of ["redact", "redactText"] as const) {
    const bridge = createNativeRedactor(validateConfig({ literals: { secret: "cretMASK" } }));
    assert.throws(() => bridge[route]!("secretMASK"), unavailable);
  }
});

test("integration V1: default production hooks take native text path; file edits retain actual UTF16 spans", async t => {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pi-redaction-v1-")));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const policy = validateConfig({ detectors: { email: true }, sources: { toolResults: true, userMessages: false } });
  const h = host(), ctx = { cwd, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
  const tracking = instrument();
  try {
    // No createRedactor injection: this is the production package-relative addon loader.
    await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: join(cwd, "policy.json"), config: policy }), loadTools });
    const raw = "🙂é owner a@b.co\n名 tail";
    const user = { role: "user", content: "deliberate@b.co" };
    assert.deepEqual(h.hooks.get("input")!({ text: user.content }, ctx), { action: "continue" });
    const result = h.hooks.get("tool_result")!({ content: [{ type: "text", text: raw }], details: { note: "clean" } }, ctx);
    assert.equal(result.content[0].text, "🙂é owner [EMAIL_1]\n名 tail");
    const context = h.hooks.get("context_with_system")!({ messages: [user, { role: "toolResult", content: result.content }] }, ctx);
    assert.equal(context.messages[0], user);
    assert.equal(tracking.calls.spans, 0, "ordinary hooks need no span response");
    assert.ok(tracking.calls.text > 0);
    await fs.writeFile(join(cwd, "file.txt"), raw);
    const execute = (name: string, params: unknown) => h.tools.get(name).execute("id", params, undefined, undefined, ctx);
    const read = await execute("read", { path: "file.txt" });
    assert.equal(read.content[0].text, "🙂é owner [EMAIL_1]\n名 tail");
    const observed = tracking.observed.find(value => value.input === raw && value.result?.matches.length);
    assert.ok(observed);
    assert.deepEqual(observed.result!.matches, [{ start: raw.indexOf("a@b.co"), end: raw.indexOf("a@b.co") + 6, replacement: "[EMAIL_1]", kind: "email" }]);
    const edited = await execute("edit", { path: "file.txt", edits: [{ oldText: "owner [EMAIL_1]", newText: "primary [EMAIL_1]" }] });
    assert.equal(edited.content[0].text, "🙂é primary [EMAIL_1]\n名 tail");
    assert.equal(await fs.readFile(join(cwd, "file.txt"), "utf8"), "🙂é primary a@b.co\n名 tail");
    const rejected = await execute("write", { path: "new.txt", content: "[EMAIL_1]" });
    assert.equal(rejected.isError, true);
    await assert.rejects(fs.access(join(cwd, "new.txt")));
    assert.equal(tracking.calls.legacy, 0);
    assert.ok(tracking.calls.spans > 0);
    assert.equal(h.hooks.get("before_provider_request")!({ payload: {} }), undefined);
  } finally { tracking.restore(); }
});

test("integration V1: text-only native refusal latches production censorship without legacy/span retry", async () => {
  const policy = validateConfig({ literals: { secret: "cretMASK" }, sources: { userMessages: true } });
  const h = host(), tracking = instrument();
  try {
    await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: "/synthetic-policy", config: policy }) });
    assert.equal(h.hooks.get("input")!({ text: "secretMASK" }, {}).text, CENSORED);
    assert.deepEqual(tracking.calls, { legacy: 0, spans: 0, text: 1 });
    assert.equal(h.hooks.get("input")!({ text: "clean" }, {}).text, CENSORED);
    assert.deepEqual(tracking.calls, { legacy: 0, spans: 0, text: 1 });
    assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: { raw: "secretMASK" } }), {});
  } finally { tracking.restore(); }
});

test("integration V1 second pass: Unicode proof and full route agree with markers at end and late Unicode", () => {
  const policy = validateConfig({ detectors: all.detectors });
  const engines = routes.map(() => fresh(policy));
  const spans = createNativeRedactor(policy), text = createNativeRedactor(policy);
  const sampledUnicode = "🙂é 名 \ufffd\0 " + "b".repeat(16384) + " ";
  const lateUnicode = "b".repeat(16384) + " 🙂é 名 \ufffd\0 ";
  const tails = ["", "[", "@", "-", "0", "9", "s", "g", "A", "x", "a@b.co", "1234567",
    "sk-abcdefghijklmnopqrstuvwxyz", "https://user:pass@example.org/x",
    "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----", "[EMAIL_73] [PHONE_88]"];
  for (const input of [...tails.flatMap(tail => [sampledUnicode + tail, lateUnicode + tail]),
    "b".repeat(62) + "🙂", "b".repeat(63) + "🙂", "b".repeat(64) + "🙂"]) {
    const expected = convertNativeResult(input, engines[0].redact(input));
    assert.equal(engines[1].redactTextV1!(input), expected.matches.length ? expected.text : null);
    assert.deepEqual(engines[2].redactSpansUtf16V1!(input), expected.matches.length ? expected : null);
    assert.deepEqual(spans.redact(input), expected);
    assert.equal(text.redactText!(input), expected.text);
    for (const match of expected.matches) assert.ok(wellFormed(input.slice(match.start, match.end)));
  }
});

test("integration V1 second pass: exact Unicode byte caps and malformed proof/fallback tails refuse safely", () => {
  const policy = validateConfig({ detectors: { email: true, phone: true } });
  const cap = 8 * 1024 * 1024;
  const boundary = "\u0800".repeat(Math.floor(cap / 3)) + "xx";
  assert.equal(Buffer.byteLength(boundary), cap);
  for (const route of ["redactTextV1", "redactSpansUtf16V1"] as const) {
    const engine = fresh(policy);
    assert.equal(engine[route]!(boundary), null);
    assert.throws(() => engine[route]!(boundary + "x"), nativeRefusal);
  }
  for (const route of ["redact", "redactText"] as const) {
    const bridge = createNativeRedactor(policy);
    assert.deepEqual(bridge[route]!(boundary), route === "redact" ? { text: boundary, matches: [] } : boundary);
    assert.throws(() => bridge[route]!(boundary + "x"), unavailable);
  }
  const malformed = ["🙂 " + "b".repeat(16384) + "\ud800", "🙂@ [EMAIL_999] " + "b".repeat(16384) + "\udfff",
    "b".repeat(16384) + "[EMAIL_999]🙂\ud800", "b".repeat(62) + "\ud800", "b".repeat(63) + "\udfff"];
  for (const route of routes) {
    const engine = fresh(policy);
    for (const input of malformed) assert.throws(() => engine[route]!(input), nativeRefusal);
    const result = engine[route]!("a@b.co");
    assert.equal(route === "redact" ? JSON.parse(result as string).text : route === "redactTextV1" ? result : (result as RedactionResult).text, "[EMAIL_1]");
  }
  for (const route of ["redact", "redactText"] as const) {
    const bridge = createNativeRedactor(policy);
    for (const input of malformed) assert.throws(() => bridge[route]!(input), unavailable);
    const result = bridge[route]!("a@b.co");
    assert.equal(typeof result === "string" ? result : result.text, "[EMAIL_1]");
  }
});

test("integration V1 second pass: bridge preserves nested parser, numeric refusal and reservation timing", () => {
  const enabled = validateConfig({ detectors: { email: true, phone: true } });
  for (const route of ["redact", "redactText"] as const) {
    const bridge = createNativeRedactor(enabled);
    const unchanged = "🙂[[EMAIL_2]][EMAIL_999999999999999999999999x][EMAIL_[PHONE_7]]";
    assert.deepEqual(bridge[route]!(unchanged), route === "redact" ? { text: unchanged, matches: [] } : unchanged);
    const changed = bridge[route]!("a@b.co 1234567");
    assert.equal(typeof changed === "string" ? changed : changed.text, "[EMAIL_3] [PHONE_8]");
    const pending = createNativeRedactor(enabled);
    assert.throws(() => pending[route]!("[EMAIL_99][EMAIL_0]"), unavailable);
    const next = pending[route]!("a@b.co");
    assert.equal(typeof next === "string" ? next : next.text, "[EMAIL_1]", "parser error commits no partial reservations");
    const crossing = createNativeRedactor(validateConfig({ literals: { hidden: "abc" }, detectors: { email: true } }));
    assert.throws(() => crossing[route]!("[EMAIL_19] z@y.co abc@b.co"), unavailable);
    const reserved = crossing[route]!("z@y.co");
    assert.equal(typeof reserved === "string" ? reserved : reserved.text, "[EMAIL_20]", "valid reservation survives later overlap refusal");
    for (const [family, label] of [["email", "EMAIL"], ["phone", "PHONE"], ["apiToken", "API_TOKEN"], ["privateKey", "PRIVATE_KEY"], ["credentialUrl", "CREDENTIAL_URL"]]) {
      const active = createNativeRedactor(validateConfig({ detectors: { [family]: true } }));
      for (const suffix of ["0", "01", "18446744073709551616", "999999999999999999999999999999"]) {
        assert.throws(() => active[route]!(`[${label}_${suffix}]`), unavailable);
        const nearMiss = `[${label}_${suffix}x]`;
        assert.deepEqual(active[route]!(nearMiss), route === "redact" ? { text: nearMiss, matches: [] } : nearMiss);
      }
      const disabled = createNativeRedactor(validateConfig({}));
      const raw = `[${label}_0]`;
      assert.deepEqual(disabled[route]!(raw), route === "redact" ? { text: raw, matches: [] } : raw);
    }
    const maximum = createNativeRedactor(enabled);
    const token = "🙂[EMAIL_18446744073709551615]";
    assert.deepEqual(maximum[route]!(token), route === "redact" ? { text: token, matches: [] } : token);
    assert.throws(() => maximum[route]!("a@b.co"), unavailable);
  }
});

test("integration V1 second pass: actual validated empty bypass keeps metadata scans/clones and sticky guards", async () => {
  const policy = validateConfig({ detectors: { email: true }, sources: { toolResults: true } });
  const h = host(), ctx = { sessionManager: { getBranch: () => [] } };
  const tracking = instrument();
  try {
    const empty = createNativeRedactor(policy);
    assert.equal(empty.redactText!(""), "");
    assert.deepEqual(empty.redact(""), { text: "", matches: [] });
    assert.deepEqual(tracking.calls, { text: 0, spans: 0, legacy: 0 });
    const invalid = createNativeRedactor({ literals: { "": "MASK" }, detectors: policy.detectors });
    assert.throws(() => invalid.redactText!(""), unavailable);
    assert.throws(() => invalid.redact(""), unavailable);
    await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: "/synthetic-policy", config: policy }), loadTools });
    const blank = h.hooks.get("tool_result")!({ content: [{ type: "text", text: "" }] }, ctx);
    assert.equal(blank.content[0].text, "");
    assert.equal(blank.details, null);
    assert.deepEqual(tracking.calls, { text: 0, spans: 0, legacy: 0 });
    const shared = { contact: "a@b.co", nested: ["", "clean"] };
    const event = { content: [{ type: "text", text: "" }, { type: "text", text: "a@b.co" }],
      details: { "a@b.co": [shared, shared], Data: "a@b.co" }, structuredContent: { items: [shared] }, isError: false, usage: { synthetic: 3 } };
    const original = JSON.stringify(event);
    const result = h.hooks.get("tool_result")!(event, ctx);
    assert.equal(result.content[1].text, "[EMAIL_1]");
    assert.equal(result.details["[EMAIL_1]"][0].contact, "[EMAIL_1]");
    assert.equal(result.details.Data, BINARY_WITHHELD);
    assert.equal(result.structuredContent.items[0].contact, "[EMAIL_1]");
    assert.equal(result.usage, event.usage);
    assert.equal(result.isError, false);
    assert.equal(JSON.stringify(event), original, "source metadata untouched");
    assert.notEqual(result.details["[EMAIL_1]"][0], shared);
    assert.notEqual(result.details["[EMAIL_1]"][0], result.details["[EMAIL_1]"][1]);
    assert.notEqual(result.details["[EMAIL_1]"][0], result.structuredContent.items[0]);
    assert.notEqual(result.details["[EMAIL_1]"][0].nested, shared.nested);
    const again = h.hooks.get("tool_result")!(event, ctx);
    assert.notEqual(again.details["[EMAIL_1]"][0], result.details["[EMAIL_1]"][0]);
    result.details["[EMAIL_1]"][0].nested[1] = "edited";
    assert.equal(shared.nested[1], "clean");
    assert.equal(again.details["[EMAIL_1]"][0].nested[1], "clean");
    assert.ok(!JSON.stringify(again).includes("a@b.co"));
    assert.equal(tracking.calls.legacy, 0);
    assert.equal(tracking.calls.spans, 0);
    assert.ok(tracking.calls.text > 0);
    const refusal = h.hooks.get("tool_result")!({ content: [{ type: "text", text: "" }], details: { malformed: "\ud800" } }, ctx);
    assert.equal(refusal.content[0].text, CENSORED);
    assert.equal(refusal.details, null);
    const before = { ...tracking.calls };
    assert.equal(h.hooks.get("tool_result")!({ content: [{ type: "text", text: "" }] }, ctx).content[0].text, CENSORED);
    assert.deepEqual(tracking.calls, before);
    assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: {} }), {});
  } finally { tracking.restore(); }
});

test("integration V1 third pass: actual certificate matches all toggles and no-marker full-scan/state results", () => {
  const kinds = ["email", "phone", "apiToken", "privateKey", "credentialUrl"] as const;
  for (let mask = 0; mask < 32; mask++) {
    const detectors = Object.fromEntries(kinds.map((kind, index) => [kind, Boolean(mask & (1 << index))]));
    const policy = validateConfig({ detectors });
    const markerSet = new Set<string>();
    if (mask) markerSet.add("[");
    if (detectors.email || detectors.credentialUrl) markerSet.add("@");
    if (detectors.phone) for (const digit of "0123456789") markerSet.add(digit);
    if (detectors.privateKey) markerSet.add("-");
    if (detectors.apiToken) for (const initial of "sgAx") markerSet.add(initial);
    const expectedMarkers = [...markerSet].sort().join("");
    const reference = fresh(policy);
    assert.equal(reference.negativeProofAsciiV1!(), expectedMarkers);
    const inputs = ["plain", "🙂名é e\u0301", "\0\t\n\"\\", "q".repeat(256), "😀".repeat(128),
      "[EMAIL_0] @ - sgAx 123", "not-an-email", "abc123", "x"].filter(input => ![...input].some(unit => markerSet.has(unit)));
    for (const input of inputs) assert.deepEqual(convertNativeResult(input, reference.redact(input)), { text: input, matches: [] });
    const next = convertNativeResult("a@b.co", reference.redact("a@b.co"));
    const tracking = instrument();
    try {
      const bridge = createNativeRedactor(policy);
      for (const input of inputs) {
        assert.equal(bridge.redactText!(input), input);
        const result = bridge.redact(input), again = bridge.redact(input);
        assert.deepEqual(result, { text: input, matches: [] });
        assert.notEqual(result, again);
        assert.notEqual(result.matches, again.matches);
      }
      assert.deepEqual(tracking.calls, { legacy: 0, text: 0, spans: 0 });
      assert.equal(tracking.proofs, 1, "certificate negotiated once, not per input");
      assert.deepEqual(bridge.redact("a@b.co"), next, "proof did not consume aliases");
      if (detectors.email || detectors.credentialUrl) assert.ok(tracking.calls.spans > 0);
    } finally { tracking.restore(); }
  }
});

test("integration V1 third pass: nonempty production metadata/key proofs clone fully; markers/history still dispatch", async () => {
  const policy = validateConfig({ detectors: { email: true, phone: true }, sources: { toolResults: true } });
  const h = host();
  let branch: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => branch }, ui: { notify() {} } };
  const tracking = instrument();
  try {
    await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: "/synthetic-policy", config: policy }), loadTools });
    const shared = { value: "plain", nested: ["🙂é名", "benign"] };
    const event = { content: [{ type: "text", text: "plain" }, { type: "text", text: "🙂é名" }],
      details: { rows: [shared, shared], Data: "synthetic" }, structuredContent: { rows: [shared] }, usage: { synthetic: 3 }, isError: false };
    const original = JSON.stringify(event);
    const result = h.hooks.get("tool_result")!(event, ctx);
    assert.equal(result.content[0].text, "plain");
    assert.equal(result.details.rows[0].value, "plain");
    assert.equal(result.details.Data, BINARY_WITHHELD);
    assert.equal(result.structuredContent.rows[0].nested[0], "🙂é名");
    assert.notEqual(result.details.rows[0], shared);
    assert.notEqual(result.details.rows[0], result.details.rows[1]);
    assert.notEqual(result.details.rows[0], result.structuredContent.rows[0]);
    assert.notEqual(result.details.rows[0].nested, shared.nested);
    assert.equal(result.usage, event.usage);
    assert.equal(result.isError, false);
    const again = h.hooks.get("tool_result")!(event, ctx);
    assert.notEqual(again.details.rows[0], result.details.rows[0]);
    result.details.rows[0].nested[0] = "edited";
    assert.equal(shared.nested[0], "🙂é名");
    assert.equal(again.details.rows[0].nested[0], "🙂é名");
    assert.equal(JSON.stringify(event), original);
    assert.deepEqual(tracking.calls, { legacy: 0, text: 0, spans: 0 }, "all nonempty text/key/value fields were certified, not skipped from sanitation");
    assert.equal(tracking.proofs, 1);
    branch = [{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "[EMAIL_9]" }] } }];
    h.hooks.get("session_start")!({}, ctx);
    assert.equal(tracking.calls.spans, 1, "historical marker invokes native reservation");
    assert.deepEqual(h.hooks.get("input")!({ text: "[EMAIL_20] intentional@b.co" }, ctx), { action: "continue" });
    assert.equal(tracking.calls.spans, 2);
    const marked = h.hooks.get("tool_result")!({ content: [{ type: "text", text: "fresh@b.co" }], details: { "other@b.co": "plain" } }, ctx);
    assert.equal(marked.content[0].text, "[EMAIL_21]");
    assert.equal(marked.details["[EMAIL_22]"], "plain");
    assert.ok(tracking.calls.text > 0);
    assert.equal(tracking.calls.legacy, 0);
    assert.equal(tracking.proofs, 1, "tree reset retains configuration certificate");
    assert.equal(h.hooks.get("before_provider_request")!({ payload: {} }), undefined);
  } finally { tracking.restore(); }
});

// Deliberately damaged capability surface on a real addon instance, not a replacement scanner.
function alteredAddon(change: (engine: InstanceType<NativeModule["NativeRedactor"]>) => void): () => NativeModule {
  return () => ({ NativeRedactor: class {
    constructor(json: string) { const engine = new NativeRedactor(json); change(engine); return engine; }
  } }) as unknown as NativeModule;
}

test("integration V1 third pass: actual construction/capability/Unicode/bounds guards precede proof", async () => {
  const policy = validateConfig({ detectors: { email: true } });
  const tracking = instrument();
  try {
    const invalid = createNativeRedactor({ literals: { "": "MASK" }, detectors: policy.detectors });
    assert.throws(() => invalid.redactText!("plain"), unavailable);
    assert.equal(tracking.proofs, 0);
    const partial = createNativeRedactor(policy, alteredAddon(engine => {
      Object.defineProperty(engine, "redactSpansUtf16V1", { value: undefined });
      Object.defineProperty(engine, "negativeProofAsciiV1", { get() { assert.fail("partial pair must refuse before reading certificate"); } });
    }));
    assert.throws(() => partial.redactText!("plain"), unavailable);
    const bridge = createNativeRedactor(policy);
    let coercions = 0;
    for (const input of ["\ud800", "q\udc00", undefined, null, { toString() { coercions++; return "plain"; } }, "é".repeat(4 * 1024 * 1024) + "x"]) {
      assert.throws(() => bridge.redactText!(input as string), unavailable);
      assert.throws(() => bridge.redact(input as string), unavailable);
    }
    assert.equal(coercions, 0);
    assert.equal(tracking.proofs, 0);
    assert.equal(bridge.redactText!("😀".repeat(128)), "😀".repeat(128));
    assert.deepEqual(tracking.calls, { legacy: 0, text: 0, spans: 0 });
    assert.equal(bridge.redactText!("😀".repeat(128) + "q"), "😀".repeat(128) + "q");
    assert.equal(tracking.calls.text, 1, "257 units must dispatch, not broaden the certificate cutoff");
    const noDescriptor = createNativeRedactor(policy, alteredAddon(engine => { Object.defineProperty(engine, "negativeProofAsciiV1", { value: undefined }); }));
    assert.equal(noDescriptor.redactText!("plain"), "plain");
    assert.equal(tracking.calls.text, 2, "older paired addon preserves full nonempty dispatch");
    const malformed = createNativeRedactor(policy, alteredAddon(engine => { Object.defineProperty(engine, "negativeProofAsciiV1", { value: () => "]" }); }));
    assert.throws(() => malformed.redactText!(""), unavailable);
    assert.throws(() => malformed.redact("plain"), unavailable);
    const h = host();
    await installRedaction(h.pi, {
      loadConfig: async () => ({ state: "active", path: "/synthetic-policy", config: validateConfig({ detectors: { email: true }, sources: { userMessages: true } }) }),
      createRedactor: config => createNativeRedactor(config, alteredAddon(engine => { Object.defineProperty(engine, "negativeProofAsciiV1", { value: () => "]" }); })),
    });
    const ctx = { sessionManager: { getBranch: () => [] } };
    assert.equal(h.hooks.get("input")!({ text: "plain" }, ctx).text, CENSORED);
    const before = { ...tracking.calls };
    assert.equal(h.hooks.get("input")!({ text: "plain" }, ctx).text, CENSORED);
    assert.deepEqual(tracking.calls, before);
    assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: {} }), {});
  } finally { tracking.restore(); }
});

test("integration V1 third pass: literal optout and native marker refusal cannot become certified returns", async () => {
  const literal = validateConfig({ literals: { q: "MASK" } });
  assert.equal(fresh(literal).negativeProofAsciiV1!(), null);
  const tracking = instrument();
  try {
    const bridge = createNativeRedactor(literal);
    assert.equal(bridge.redactText!("q"), "MASK");
    assert.deepEqual(bridge.redact("🙂q"), { text: "🙂MASK", matches: [{ start: 2, end: 3, replacement: "MASK", kind: "literal" }] });
    assert.deepEqual(tracking.calls, { legacy: 0, text: 1, spans: 1 });
    const h = host(), policy = validateConfig({ detectors: { email: true }, sources: { userMessages: true } });
    const ctx = { sessionManager: { getBranch: () => [] } };
    await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: "/synthetic-policy", config: policy }) });
    assert.equal(h.hooks.get("input")!({ text: "[EMAIL_01]" }, ctx).text, CENSORED);
    assert.equal(tracking.calls.text, 2, "malformed alias marker reaches native refusal");
    const before = { ...tracking.calls };
    assert.equal(h.hooks.get("input")!({ text: "plain" }, ctx).text, CENSORED);
    assert.deepEqual(tracking.calls, before, "sticky failure precedes later otherwise-certifiable field");
    assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: {} }), {});
  } finally { tracking.restore(); }
});

test("integration V1 third pass: Unicode aliases at every position retain full-route spans and exact state", () => {
  const policy = validateConfig({ detectors: { email: true, phone: true } });
  const engines = routes.map(() => fresh(policy));
  const spans = createNativeRedactor(policy), text = createNativeRedactor(policy);
  const clean = "🙂名é " + "b".repeat(16384) + " ";
  for (const input of ["[EMAIL_41] " + clean, clean.slice(0, 100) + "[PHONE_7]" + clean.slice(100),
    clean + "[EMAIL_44]", clean + "123456", clean + "1234567", clean + "[EMAIL_[PHONE_9]]",
    clean + "[EMAIL_44] a@b.co", clean + "https://user:pass@[EMAIL_55]/", "b".repeat(16384) + "🙂[EMAIL_60]"]) {
    const expected = convertNativeResult(input, engines[0].redact(input));
    assert.equal(engines[1].redactTextV1!(input), expected.matches.length ? expected.text : null);
    assert.deepEqual(engines[2].redactSpansUtf16V1!(input), expected.matches.length ? expected : null);
    assert.deepEqual(spans.redact(input), expected);
    assert.equal(text.redactText!(input), expected.text);
  }
  const nextInput = "fresh@b.co 7654321";
  const expected = convertNativeResult(nextInput, engines[0].redact(nextInput));
  assert.equal(engines[1].redactTextV1!(nextInput), expected.text);
  assert.deepEqual(engines[2].redactSpansUtf16V1!(nextInput), expected);
  assert.deepEqual(spans.redact(nextInput), expected);
  assert.equal(text.redactText!(nextInput), expected.text);
  assert.equal(expected.text, "[EMAIL_61] [PHONE_10]");
});
