import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileSession, Redactor } from "../src/contracts.ts";
import type { Dependencies } from "../src/index.ts";
import { installRedaction } from "../src/index.ts";
import { offConfig, validateConfig } from "../src/config.ts";
import { BINARY_WITHHELD, CENSORED } from "../src/sanitize.ts";

// A fake host captures the actual registered hook functions (not separate sanitizer-only logic).
function host() {
  const hooks = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sessionManager = { getBranch: () => [] };
  const context = { sessionManager, ui: { notify() {} } };
  const pi = {
    on(name: string, fn: (...args: any[]) => any) { hooks.set(name, (event, ctx = context) => fn(event, ctx)); },
    registerTool(tool: any) { tools.set(tool.name, { ...tool, execute: (id: string, params: any, signal: any, update: any, ctx: any) => tool.execute(id, params, signal, update, { sessionManager, ...ctx }) }); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  return { pi, hooks, tools, commands };
}
const fakeTools = async () => ({
  createReadToolDefinition: () => ({ name: "read", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } }, outputSchema: { type: "string" } }),
  createEditToolDefinition: () => ({ name: "edit", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } } } }),
  createWriteToolDefinition: () => ({ name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } }),
}) as unknown as Awaited<ReturnType<NonNullable<Dependencies["loadTools"]>>>;
function redactor(): Redactor {
  return { redact(text) { return { text: text.replaceAll("synthetic-secret", "PRIVATE"), matches: [] }; }, reset() {} };
}
function fileSession(): FileSession {
  return { async read() { return { text: "PRIVATE", path: "safe.txt" }; }, async edit() { throw new Error("unexpected single edit"); }, async editMany() { return { text: "edited safely", path: "safe.txt" }; }, async write() { return { text: "written safely", path: "safe.txt" }; }, async rememberPath(path) { return path; }, reset() {} };
}
async function setup(flags = { toolResults: true, userMessages: false, systemPrompt: true }, overrides: Dependencies = {}) {
  const h = host();
  const config = offConfig();
  config.literals = { "synthetic-secret": "PRIVATE" };
  config.sources = flags;
  await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: "/synthetic/config.json", config }), createRedactor: redactor, createFileSession: fileSession, loadTools: fakeTools, ...overrides });
  return h;
}
const usage = { input: 1, output: 2, totalTokens: 3, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const toolEvent = () => ({ type: "tool_result", toolName: "custom", toolCallId: "id", input: {}, content: [{ type: "text", text: "synthetic-secret" }], details: { "synthetic-secret": { nested: ["synthetic-secret"], omitted: undefined } }, structuredContent: { value: "synthetic-secret" }, usage, isError: true });

test("inactive configuration registers only safe status; no native, file imports, overrides or filters", async () => {
  const h = host();
  await installRedaction(h.pi, { loadConfig: async () => ({ state: "inactive", path: "/synthetic/config", config: offConfig() }), createRedactor() { throw new Error("must not load"); }, createFileSession() { throw new Error("must not load"); }, loadTools: async () => { throw new Error("must not load"); } });
  assert.equal(h.hooks.size, 0);
  assert.equal(h.tools.size, 0);
  const notices: string[] = [];
  await h.commands.get("redaction-status").handler("", { ui: { notify: (text: string) => notices.push(text) } });
  assert.match(notices[0], /inactive/);
});
test("tool_result returns the Pi replacement fields, recursively scrubbing details/structured data, preserving usage and error", async () => {
  const h = await setup();
  const event = toolEvent();
  const result = h.hooks.get("tool_result")!(event);
  assert.deepEqual(result.content, [{ type: "text", text: "PRIVATE" }]);
  assert.equal(result.details.PRIVATE.nested[0], "PRIVATE");
  assert.equal(result.structuredContent.value, "PRIVATE");
  assert.equal(result.usage, usage);
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  assert.equal(event.content[0].text, "synthetic-secret", "does not mutate event/persisted original");
  assert.equal(h.hooks.get("before_provider_request")!({ payload: { opaque: "synthetic-secret" } }), undefined, "no blanket payload rewrite");
});
test("context_with_system separates direct user text from protected tools/system/history and leaves protocol IDs/signatures unchanged", async () => {
  const h = await setup();
  const signed = { type: "thinking", thinking: "synthetic-secret", thinkingSignature: "opaque-synthetic-secret" };
  const messages = [
    { role: "system", content: "synthetic-secret", sections: { project: "synthetic-secret", deleted: null }, toolsAdded: [{ name: "synthetic-secret", description: "synthetic-secret", parameters: { type: "object" } }], timestamp: 0 },
    { role: "user", content: "synthetic-secret", timestamp: 1 },
    { role: "toolResult", toolName: "synthetic-secret", toolCallId: "synthetic-secret", content: [{ type: "text", text: "synthetic-secret" }], details: { value: "synthetic-secret" }, timestamp: 2 },
    { role: "assistant", content: [{ type: "text", text: "synthetic-secret" }, signed, { type: "toolCall", id: "synthetic-secret", name: "synthetic-secret", arguments: { path: "synthetic-secret", "synthetic-secret": "synthetic-secret" } }], timestamp: 3 },
    { role: "bashExecution", command: "synthetic-secret", output: "synthetic-secret", timestamp: 4 },
    { role: "compactionSummary", summary: "synthetic-secret", timestamp: 5 },
    { role: "custom", content: "synthetic-secret", timestamp: 6 },
  ];
  const result = h.hooks.get("context_with_system")!({ messages }).messages;
  assert.equal(result[0].role, "system");
  assert.equal(result[0].content, "PRIVATE");
  assert.equal(result[0].sections.project, "PRIVATE");
  assert.equal(result[0].toolsAdded[0].name, "synthetic-secret");
  assert.equal(result[0].toolsAdded[0].description, "PRIVATE");
  assert.equal(result[1], messages[1], "deliberately typed text retained verbatim");
  assert.equal(result[2].toolCallId, "synthetic-secret");
  assert.equal(result[2].content[0].text, "PRIVATE");
  assert.equal(result[3].content[0].text, "PRIVATE");
  assert.equal(result[3].content[1], signed);
  assert.equal(result[3].content[2].arguments.path, "PRIVATE");
  assert.equal(result[3].content[2].arguments["synthetic-secret"], "PRIVATE", "argument schema identities are not rewritten");
  assert.equal(result[3].content[2].id, "synthetic-secret");
  assert.equal(result[4].output, "PRIVATE");
  assert.equal(result[5].summary, "PRIVATE");
  assert.equal(result[6].content, "PRIVATE");
  assert.deepEqual(h.hooks.get("input")!({ text: "synthetic-secret" }), { action: "continue" });
});
test("sources remain independent and user filtering transforms text while dropping protected images", async () => {
  const h = await setup({ toolResults: false, userMessages: true, systemPrompt: false });
  assert.equal(h.tools.size, 0);
  assert.equal(h.hooks.get("tool_result")!(toolEvent()), undefined);
  assert.deepEqual(h.hooks.get("input")!({ text: "synthetic-secret", images: [{ type: "image", data: "opaque" }] }), { action: "transform", text: "PRIVATE", images: [] });
  const messages = [{ role: "system", content: "synthetic-secret" }, { role: "user", content: "synthetic-secret" }, { role: "toolResult", content: [{ type: "text", text: "synthetic-secret" }] }];
  const result = h.hooks.get("context_with_system")!({ messages }).messages;
  assert.equal(result[0], messages[0]);
  assert.equal(result[1].content, "PRIVATE");
  assert.equal(result[2], messages[2]);
});
test("tool images never masquerade as OCR; protected binary data is withheld", async () => {
  const h = await setup();
  const result = h.hooks.get("tool_result")!({ ...toolEvent(), content: [{ type: "image", data: "opaque", mimeType: "image/png" }], details: { data: "opaque" } });
  assert.equal(result.content[0].text, BINARY_WITHHELD);
  assert.equal(result.details.data, BINARY_WITHHELD);
  const signed = h.hooks.get("tool_result")!({ ...toolEvent(), content: [{ type: "text", text: "synthetic-secret", textSignature: "opaque" }] });
  assert.equal(signed.content[0].text, BINARY_WITHHELD);
});
test("native/sanitizer failure returns safe censor values, not a swallowed hook throw", async () => {
  const h = await setup(undefined, { createRedactor: () => ({ redact() { throw new Error("synthetic-secret"); }, reset() {} }) });
  const result = h.hooks.get("tool_result")!(toolEvent());
  assert.equal(result.details, null, "Pi requires null to replace raw details");
  assert.equal(result.structuredContent, null);
  assert.equal(result.content[0].text, CENSORED);
  assert.equal(result.usage, usage);
  assert.equal(result.isError, true);
  const context = h.hooks.get("context_with_system")!({ messages: [{ role: "system", content: "synthetic-secret" }, { role: "user", content: "synthetic-secret" }] });
  assert.equal(context.messages[0].content, CENSORED);
  assert.equal(context.messages[1].content, "synthetic-secret", "direct user exemption retained in fallback context");
  assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: { raw: "synthetic-secret" } }), {}, "returns replacement payload, not {payload:{}} or a throw");
});
test("invalid explicit configuration censors input, result, complete request without needing native", async () => {
  const h = host();
  await installRedaction(h.pi, { loadConfig: async () => ({ state: "invalid", path: "/synthetic/config" }), createRedactor() { throw new Error("must not load"); }, createFileSession: fileSession, loadTools: fakeTools });
  assert.equal(h.hooks.get("input")!({ text: "synthetic-secret" }).text, CENSORED);
  assert.equal(h.hooks.get("tool_result")!(toolEvent()).details, null);
  assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: { raw: "synthetic-secret" } }), {});
});
test("file overrides preserve schemas, forward edits as ONE batch, protect config path, and never unmask arbitrary tool args", async () => {
  let passedOptions: any, passedBatch: any, writes = 0;
  const h = await setup(undefined, { createFileSession(options) {
    passedOptions = options;
    return { ...fileSession(), async editMany(input) { passedBatch = input; writes++; return { text: "all edits accepted", path: "safe" }; } };
  } });
  const params = { path: "PRIVATE.txt", edits: [{ oldText: "PRIVATE", newText: "PRIVATE one" }, { oldText: "other", newText: "two" }] };
  const result = await h.tools.get("edit").execute("id", params, undefined, undefined, { cwd: "/synthetic/workspace" });
  assert.equal(passedBatch, params);
  assert.equal(writes, 1);
  assert.equal(result.content[0].text, "all edits accepted");
  assert.deepEqual(passedOptions.protectedPaths, ["/synthetic/config.json"]);
  assert.deepEqual(passedOptions.literalMappings, { "synthetic-secret": "PRIVATE" });
  assert.equal(h.hooks.has("tool_call"), false, "no global reverse mapping");
  const read = await h.tools.get("read").execute("id", { path: "PRIVATE" }, undefined, undefined, { cwd: "/synthetic/workspace" });
  assert.equal(read.structuredContent, "PRIVATE");
  assert.equal(h.tools.get("read").parameters.properties.offset.type, "number");
});
test("file session receives complete custom literal aliases before any read or native emission", async () => {
  const config = validateConfig({ literals: { "synthetic-never-seen": "CUSTOM_PRIVATE_ALIAS", "second-never-seen": "ANOTHER_CUSTOM_ALIAS" }, sources: { toolResults: true } });
  let writes = 0;
  const h = await setup(undefined, {
    loadConfig: async () => ({ state: "active", path: "/synthetic/config.json", config }),
    createRedactor() { throw new Error("No native alias emission should precede this write"); },
    createFileSession(options) {
      assert.equal(options.literalMappings, config.literals, "pass the complete validated dictionary, not only observed matches");
      assert.deepEqual(Object.values(options.literalMappings!), ["CUSTOM_PRIVATE_ALIAS", "ANOTHER_CUSTOM_ALIAS"]);
      return { ...fileSession(),
        async read() { throw new Error("No read should precede this write"); },
        async write(input) {
          writes++;
          // The mock verifies inventory delivery; real alias-injection safety belongs to file-tools tests.
          assert.ok(Object.values(options.literalMappings!).includes(input.content));
          throw new Error("Unobserved configured alias refused by adapter");
        },
      };
    },
  });
  const result = await h.tools.get("write").execute("id", { path: "new.txt", content: "CUSTOM_PRIVATE_ALIAS" }, undefined, undefined, { cwd: "/synthetic/workspace" });
  assert.equal(writes, 1);
  assert.equal(result.isError, true);
});
test("literal-free active file session still receives explicit empty literalMappings", async () => {
  const config = validateConfig({ detectors: { email: true }, sources: { toolResults: true } });
  let created = false;
  const h = await setup(undefined, {
    loadConfig: async () => ({ state: "active", path: "/synthetic/config.json", config }),
    createFileSession(options) {
      assert.ok(Object.hasOwn(options, "literalMappings"));
      assert.equal(options.literalMappings, config.literals);
      assert.deepEqual(options.literalMappings, {});
      created = true;
      return fileSession();
    },
  });
  const result = await h.tools.get("write").execute("id", { path: "new.txt", content: "ordinary text" }, undefined, undefined, { cwd: "/synthetic/workspace" });
  assert.equal(created, true);
  assert.equal(result.content[0].text, "written safely");
});
test("batch adapter refusal and cancellation produce safe error results; no retry as single edits", async () => {
  let calls = 0;
  const h = await setup(undefined, { createFileSession: () => ({ ...fileSession(), async editMany() { calls++; throw new Error("synthetic-secret raw path"); } }) });
  const result = await h.tools.get("edit").execute("id", { path: "safe", edits: [{ oldText: "first", newText: "1" }, { oldText: "missing", newText: "2" }] }, undefined, undefined, { cwd: "/synthetic" });
  assert.equal(calls, 1);
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  const aborted = new AbortController(); aborted.abort("synthetic-secret");
  const cancelled = await h.tools.get("edit").execute("id", {}, aborted.signal, undefined, { cwd: "/synthetic" });
  assert.equal(cancelled.isError, true);
  assert.equal(calls, 1);
});
test("unsupported tool details fail safely and missing file adapter initialization blocks built-in file tools", async () => {
  const h = await setup();
  const cyclic: any = {}; cyclic.self = cyclic;
  assert.equal(h.hooks.get("tool_result")!({ ...toolEvent(), details: cyclic }).details, null);
  assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: {} }), {});
  const broken = await setup(undefined, { loadTools: async () => { throw new Error("synthetic-secret"); } });
  assert.equal(broken.tools.size, 0);
  assert.deepEqual(broken.hooks.get("tool_call")!({ toolName: "read" }), { block: true, reason: CENSORED });
  assert.deepEqual(broken.hooks.get("before_provider_request")!({ payload: {} }), {});
});
