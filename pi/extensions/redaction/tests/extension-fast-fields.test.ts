import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { Dependencies } from "../src/index.ts";
import { installRedaction } from "../src/index.ts";
import { offConfig } from "../src/config.ts";
import { BINARY_WITHHELD, CENSORED, sanitizeJson, sanitizeToolResult } from "../src/sanitize.ts";

const secrets = { "arden@example.test": "CONTACT_A", "river@example.test": "CONTACT_B", "+14155550132": "PHONE_A" };
// Literal filter mock; real-addon hot-path probes separately exercise actual email/phone detection.
const filter = (input: string) => Object.entries(secrets).reduce((text, [raw, alias]) => text.replaceAll(raw, alias), input);
const event = (fields: object = {}) => ({ type: "tool_result", toolName: "synthetic", toolCallId: "id", input: {}, content: [{ type: "text", text: "safe" }], details: undefined, isError: false, ...fields }) as ToolResultEvent;

test("small-field sanitation still scrubs nested secrets in values and keys, withholding binary fields", () => {
  const source = event({
    content: ["", "x", "safe", "arden@example.test"].map(text => ({ type: "text", text })),
    details: { "arden@example.test": { rows: [{ contact: "river@example.test", number: "+14155550132" }], Data: { raw: "arden@example.test" }, ThInKiNgSiGnAtUrE: "river@example.test", omitted: undefined } },
    structuredContent: { "river@example.test": ["", { nested: "+14155550132" }] },
  });
  const result = sanitizeToolResult(source, filter);
  const details = result.details as any;
  const structured = result.structuredContent as any;
  assert.equal(details.CONTACT_A.rows[0].contact, "CONTACT_B");
  assert.equal(details.CONTACT_A.rows[0].number, "PHONE_A");
  assert.equal(details.CONTACT_A.Data, BINARY_WITHHELD);
  assert.equal(details.CONTACT_A.ThInKiNgSiGnAtUrE, BINARY_WITHHELD);
  assert.equal(Object.hasOwn(details.CONTACT_A, "omitted"), false);
  assert.equal(structured.CONTACT_B[1].nested, "PHONE_A");
  for (const secret of Object.keys(secrets)) assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal((source.details as any)["arden@example.test"].rows[0].contact, "river@example.test", "original event unchanged");
});

test("benign no-match JSON remains deeply cloned, including repeated objects and sparse arrays", () => {
  const shared = { value: "safe" };
  const sparse: unknown[] = new Array(3); sparse[1] = shared;
  const source = { nested: [shared, shared], sparse, nullObject: Object.assign(Object.create(null), { value: "ok" }) };
  const result = sanitizeJson(source, value => value) as any;
  assert.notEqual(result, source);
  assert.notEqual(result.nested, source.nested);
  assert.notEqual(result.nested[0], shared);
  assert.notEqual(result.nested[0], result.nested[1]);
  assert.notEqual(result.sparse, sparse);
  assert.equal(0 in result.sparse, false);
  assert.equal(2 in result.sparse, false);
  assert.equal(Object.getPrototypeOf(result), null);
  assert.equal(Object.getPrototypeOf(result.nullObject), null);
  result.nested[0].value = "edited";
  result.nullObject.value = "changed";
  assert.equal(shared.value, "safe");
  assert.equal(source.nullObject.value, "ok");
  for (const value of ["", "x", null, true, 0]) assert.equal(sanitizeJson(value, item => item), value);
});

test("sanitizer keeps entry value snapshots, validation, collision detection and depth/cycle policy", () => {
  const source = { first: "old", second: "snapshot" };
  const result = sanitizeJson(source, value => { if (value === "first") source.second = "later"; return value; }) as any;
  assert.equal(result.second, "snapshot", "entry values captured before key sanitation, as before");
  for (const value of [new Date(0), new Map(), NaN, Infinity, 1n, Symbol("synthetic"), () => {}, { get secret() { throw new Error("synthetic getter refusal"); } }]) {
    assert.throws(() => sanitizeJson(value, filter));
  }
  const cycle: any = {}; cycle.next = cycle;
  assert.throws(() => sanitizeJson(cycle, filter));
  assert.throws(() => sanitizeJson({ a: "safe", b: "safe" }, () => "COLLISION"));
  assert.throws(() => sanitizeJson("", filter, undefined, 101));
  const sentinel = {};
  const seen = new Set<object>([sentinel]);
  assert.throws(() => sanitizeJson(cycle, filter, seen));
  assert.deepEqual([...seen], [sentinel], "failed traversal releases only its own active entries");
  const argument = sanitizeJson({ data: "arden@example.test", textSignature: "river@example.test", "arden@example.test": "+14155550132" }, filter, undefined, 0, true) as any;
  assert.equal(argument.data, "CONTACT_A");
  assert.equal(argument.textSignature, "CONTACT_B");
  assert.equal(argument["arden@example.test"], "PHONE_A", "argument property identities retained");
});

test("metadata collision latches censorship before later empty hook calls, retaining user exemption", async () => {
  const config = offConfig(); config.literals = { a: "MASK" }; config.sources.toolResults = true;
  const hooks = new Map<string, (...args: any[]) => any>();
  let scans = 0;
  const ctx = { sessionManager: { getBranch: () => [] } };
  await installRedaction({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI, {
    loadConfig: async () => ({ state: "active", config, path: "/synthetic/policy.json" }),
    createRedactor: () => ({ redact(text) { return { text, matches: [] }; }, redactText(text) { scans++; return text === "a" || text === "b" ? "MASK" : text; }, reset() {} }),
    createFileSession() { throw new Error("no file operations"); },
    loadTools: async () => Object.fromEntries(["read", "edit", "write"].map(name => [`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`, () => ({ name, parameters: {} })])) as unknown as Awaited<ReturnType<NonNullable<Dependencies["loadTools"]>>>,
  });
  const result = hooks.get("tool_result")!(event({ details: { a: "safe", b: "safe" } }), ctx);
  assert.equal(result.content[0].text, CENSORED);
  assert.equal(result.details, null);
  assert.equal(result.structuredContent, null);
  const before = scans;
  const empty = hooks.get("tool_result")!(event({ content: [{ type: "text", text: "" }] }), ctx);
  assert.equal(empty.content[0].text, CENSORED);
  assert.equal(scans, before, "empty optimization cannot bypass sticky caller failure");
  assert.deepEqual(hooks.get("input")!({ text: "intentional@example.test" }, ctx), { action: "continue" });
  assert.deepEqual(hooks.get("before_provider_request")!({ payload: { raw: "private" } }, ctx), {});
});

test("empty protected tool results still require historical-ID guards before any fast scan", async () => {
  for (const sessionManager of [undefined, { getBranch() { throw new Error("synthetic history refusal"); } }]) {
    const config = offConfig(); config.detectors.email = true; config.sources.toolResults = true;
    const hooks = new Map<string, (...args: any[]) => any>();
    let loads = 0;
    await installRedaction({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); }, registerCommand() {}, registerTool() {} } as unknown as ExtensionAPI, {
      loadConfig: async () => ({ state: "active", config, path: "/synthetic/policy.json" }),
      createRedactor() { loads++; throw new Error("must guard history before engine"); },
      createFileSession() { throw new Error("no file operations"); },
      loadTools: async () => Object.fromEntries(["read", "edit", "write"].map(name => [`create${name[0].toUpperCase()}${name.slice(1)}ToolDefinition`, () => ({ name, parameters: {} })])) as unknown as Awaited<ReturnType<NonNullable<Dependencies["loadTools"]>>>,
    });
    const result = hooks.get("tool_result")!(event({ content: [{ type: "text", text: "" }] }), { sessionManager });
    assert.equal(result.content[0].text, CENSORED);
    assert.deepEqual(hooks.get("before_provider_request")!({}), {});
    assert.equal(loads, 0);
  }
});
