import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Dependencies } from "../src/index.ts";
import { installRedaction } from "../src/index.ts";
import { validateConfig } from "../src/config.ts";
import { createNativeRedactor } from "../src/native.ts";
import { createFileSession } from "../src/file-tools.ts";
import { CENSORED } from "../src/sanitize.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const literal = "arden@example.test";
const automatic = "river@example.test";
const config = () => validateConfig({ literals: { [literal]: "PRIVATE_CONTACT" }, detectors: { email: true }, sources: { toolResults: true } });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "pi-redaction-integration-")));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const policy = config();
  const redactor = createNativeRedactor(policy);
  const session = createFileSession({ cwd, redactor, literalMappings: policy.literals, protectedPaths: [join(cwd, "private-policy.json")] });
  const ctx = { cwd, sessionManager: { getBranch: () => [] }, ui: { notify() {} } };
  return { cwd, policy, redactor, session, ctx, put: (name: string, text: string) => fs.writeFile(join(cwd, name), text), get: (name: string) => fs.readFile(join(cwd, name), "utf8") };
}
function host() {
  const hooks = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {} } as unknown as ExtensionAPI;
  return { pi, hooks, tools };
}
// Only the host registration/schema factory is injected. Engine and filesystem are real.
const loadTools: NonNullable<Dependencies["loadTools"]> = async () => ({
  createReadToolDefinition: () => ({ name: "read", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } } } }),
  createEditToolDefinition: () => ({ name: "edit", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } } } }),
  createWriteToolDefinition: () => ({ name: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } } }),
}) as unknown as Awaited<ReturnType<NonNullable<Dependencies["loadTools"]>>>;

test("integration: inactive package imports and installs without native binary or Pi runtime dependencies", async t => {
  const f = await fixture(t);
  const copy = join(f.cwd, "source-only");
  await fs.mkdir(copy);
  for (const name of ["index.ts", "src", "package.json"]) await fs.cp(join(packageRoot, name), join(copy, name), { recursive: true });
  await assert.rejects(fs.access(join(copy, "native/redaction.node")));
  const script = `const {default: install} = await import(${JSON.stringify(pathToFileURL(join(copy, "index.ts")).href)}); let commands = 0; await install({registerCommand(){commands++},on(){throw Error('inactive hook')},registerTool(){throw Error('inactive tool')}}); if(commands !== 2) throw Error('missing commands'); console.log('inactive source-only import passed');`;
  for (const present of [false, true]) {
    const configHome = join(f.cwd, present ? "all-off-config" : "absent-config");
    if (present) {
      await fs.mkdir(join(configHome, "pi-redaction"), { recursive: true, mode: 0o700 });
      await fs.writeFile(join(configHome, "pi-redaction/config.json"), JSON.stringify(validateConfig({})), { mode: 0o600 });
    }
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: copy, env: { ...process.env, XDG_CONFIG_HOME: configHome }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /inactive source-only import passed/);
  }
});

test("integration: real native bridge converts Unicode offsets and independently honors opt-ins", () => {
  const engine = createNativeRedactor(config());
  const input = `🙂e\u0301 名 ${literal} / ${automatic}`;
  const result = engine.redact(input);
  assert.equal(result.text, "🙂e\u0301 名 PRIVATE_CONTACT / [EMAIL_1]");
  assert.deepEqual(result.matches.map(m => input.slice(m.start, m.end)), [literal, automatic]);
  assert.equal(result.matches[0].start, input.indexOf(literal));
  assert.equal(engine.redact(result.text).text, result.text);
  const off = createNativeRedactor(validateConfig({}));
  assert.deepEqual(off.redact(automatic), { text: automatic, matches: [] });
  assert.equal(createNativeRedactor(validateConfig({ detectors: { email: true } })).redact("a@b.co").text, "[EMAIL_1]");
});

test("integration: native/file Unicode read, disjoint batch and whole write restore only observed originals", async t => {
  const f = await fixture(t);
  const name = "unicode.txt";
  const raw = `🙂 owner ${literal}\n名 backup ${automatic}\n`;
  await f.put(name, raw);
  const read = await f.session.read({ path: name });
  assert.equal(read.text, "🙂 owner PRIVATE_CONTACT\n名 backup [EMAIL_1]\n");
  assert.ok(!JSON.stringify(read).includes(literal));
  assert.equal(await f.get(name), raw);
  const edit = await f.session.editMany({ path: read.path, edits: [
    { oldText: "owner PRIVATE_CONTACT", newText: "primary PRIVATE_CONTACT" },
    { oldText: "backup [EMAIL_1]", newText: "secondary [EMAIL_1]" },
  ] });
  assert.equal(edit.text, "🙂 primary PRIVATE_CONTACT\n名 secondary [EMAIL_1]\n");
  assert.equal(await f.get(name), `🙂 primary ${literal}\n名 secondary ${automatic}\n`);
  const written = await f.session.write({ path: read.path, content: "名 [EMAIL_1]\n🙂 PRIVATE_CONTACT / PRIVATE_CONTACT\n" });
  assert.equal(written.text, "名 [EMAIL_1]\n🙂 PRIVATE_CONTACT / PRIVATE_CONTACT\n");
  assert.equal(await f.get(name), `名 ${automatic}\n🙂 ${literal} / ${literal}\n`);
});

test("integration: actual generated path requires observation and scopes do not grant cross-file restoration", async t => {
  const f = await fixture(t);
  await f.put(`${automatic}.txt`, automatic);
  await assert.rejects(f.session.read({ path: "[EMAIL_1].txt" }));
  const path = await f.session.rememberPath(`${automatic}.txt`);
  const observed = (await f.session.read({ path })).text;
  assert.match(observed, /^\[EMAIL_\d+\]$/);
  assert.equal(observed, f.redactor.redact(automatic).text, "paths and contents share session identities, not assumed token IDs");
  await f.put("other.txt", "ordinary");
  await f.session.read({ path: "other.txt" });
  await assert.rejects(f.session.write({ path: "other.txt", content: observed }));
  await assert.rejects(f.session.write({ path: "new.txt", content: "PRIVATE_CONTACT" }));
  assert.equal(await f.get("other.txt"), "ordinary");
  await assert.rejects(fs.access(join(f.cwd, "new.txt")));
});

test("integration: partial views, failed batches, stale originals and raw alias collisions refuse without mutation", async t => {
  const f = await fixture(t);
  const raw = `first ${literal}\nsecond ${automatic}\n`;
  await f.put("a.txt", raw);
  await f.session.read({ path: "a.txt", limit: 1 });
  await assert.rejects(f.session.editMany({ path: "a.txt", edits: [
    { oldText: "first PRIVATE_CONTACT", newText: "updated PRIVATE_CONTACT" },
    { oldText: "second [EMAIL_1]", newText: "hidden [EMAIL_1]" },
  ] }));
  assert.equal(await f.get("a.txt"), raw);
  await f.session.read({ path: "a.txt" });
  await f.put("a.txt", raw + "external\n");
  await assert.rejects(f.session.write({ path: "a.txt", content: "PRIVATE_CONTACT" }));
  assert.equal(await f.get("a.txt"), raw + "external\n");
  await f.put("collision.txt", `PRIVATE_CONTACT ${literal}`);
  await assert.rejects(f.session.read({ path: "collision.txt" }));
  await f.put("generated.txt", `[EMAIL_1] ${automatic}`);
  await assert.rejects(f.session.read({ path: "generated.txt" }));
  await f.put("private-policy.json", "synthetic private policy");
  await assert.rejects(f.session.read({ path: "private-policy.json" }));
});

test("integration: Pi file overrides use real native/file adapters and preserve direct user exemption", async t => {
  const f = await fixture(t);
  const h = host();
  await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: join(f.cwd, "private-policy.json"), config: f.policy }), loadTools });
  await f.put("a.txt", `🙂 ${literal} ${automatic}`);
  const execute = (tool: string, params: unknown) => h.tools.get(tool).execute("synthetic-id", params, undefined, undefined, f.ctx);
  const read = await execute("read", { path: "a.txt" });
  assert.equal(read.content[0].text, "🙂 PRIVATE_CONTACT [EMAIL_1]");
  assert.equal(read.structuredContent, read.content[0].text);
  const edit = await execute("edit", { path: "a.txt", edits: [{ oldText: "🙂 PRIVATE_CONTACT", newText: "名 PRIVATE_CONTACT" }] });
  assert.equal(edit.content[0].text, "名 PRIVATE_CONTACT [EMAIL_1]");
  const write = await execute("write", { path: "a.txt", content: "🙂 [EMAIL_1] PRIVATE_CONTACT" });
  assert.equal(write.content[0].text, "🙂 [EMAIL_1] PRIVATE_CONTACT");
  assert.equal(await f.get("a.txt"), `🙂 ${automatic} ${literal}`);
  const input = { text: automatic };
  assert.deepEqual(h.hooks.get("input")!(input, f.ctx), { action: "continue" });
  const user = { role: "user", content: automatic };
  const filtered = h.hooks.get("context_with_system")!({ messages: [user, { role: "toolResult", content: [{ type: "text", text: automatic }] }] }, f.ctx).messages;
  assert.equal(filtered[0], user);
  assert.equal(filtered[1].content[0].text, "[EMAIL_1]");
  assert.equal(h.hooks.get("before_provider_request")!({ payload: {} }), undefined);
});

test("integration: bounded file refusal precedes truncation and preserves existing native scopes", async t => {
  const f = await fixture(t);
  const h = host();
  await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: join(f.cwd, "private-policy.json"), config: f.policy }), loadTools });
  const raw = `visible\n${"x".repeat(8 * 1024 * 1024)} ${automatic}`;
  await f.put("large.txt", raw);
  const result = await h.tools.get("read").execute("id", { path: "large.txt", limit: 1 }, undefined, undefined, f.ctx);
  assert.equal(result.isError, true);
  assert.ok(!JSON.stringify(result).includes(automatic));
  assert.equal(await f.get("large.txt"), raw);
  assert.equal(h.hooks.get("before_provider_request")!({ payload: {} }), undefined);
  assert.equal(h.hooks.get("tool_result")!({ content: [{ type: "text", text: automatic }] }, f.ctx).content[0].text, "[EMAIL_1]");
});

test("integration: literal-only native resolves embedded filenames; partial detector overlap refuses safely", async t => {
  const f = await fixture(t);
  const policy = validateConfig({ literals: { [literal]: "PRIVATE_CONTACT" } });
  const session = createFileSession({ cwd: f.cwd, redactor: createNativeRedactor(policy), literalMappings: policy.literals });
  const name = `note-${literal}.txt`;
  await f.put(name, `🙂 ${literal}`);
  const read = await session.read({ path: "note-PRIVATE_CONTACT.txt" });
  assert.equal(read.text, "🙂 PRIVATE_CONTACT");
  assert.equal(read.path, join(f.cwd, "note-PRIVATE_CONTACT.txt"));
  await session.edit({ path: read.path, oldText: "🙂 PRIVATE_CONTACT", newText: "名 PRIVATE_CONTACT" });
  assert.equal(await f.get(name), `名 ${literal}`);
  // With email detection enabled, the filename is a larger email candidate than
  // the embedded literal. Approved overlap policy refuses, rather than leaking.
  await assert.rejects(f.session.read({ path: "note-PRIVATE_CONTACT.txt" }));
  assert.equal(await f.get(name), `名 ${literal}`);
});

test("integration: actual native P1 alias-boundary refusal censors registered tool/context hooks and requests", async t => {
  const f = await fixture(t);
  const policy = validateConfig({ literals: { secret: "cretMASK" }, sources: { toolResults: true, userMessages: true, systemPrompt: true } });
  for (const first of ["tool_result", "context_with_system"]) {
    const h = host();
    await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: join(f.cwd, "private-policy.json"), config: policy }), loadTools });
    const messages = [{ role: "system", content: "secretMASK" }, { role: "toolResult", content: [{ type: "text", text: "secretMASK" }] }];
    if (first === "tool_result") {
      const result = h.hooks.get(first)!({ content: [{ type: "text", text: "secretMASK" }], details: { raw: "secretMASK" }, structuredContent: "secretMASK" }, f.ctx);
      assert.equal(result.content[0].text, CENSORED);
      assert.equal(result.details, null);
      assert.equal(result.structuredContent, null);
      assert.ok(!JSON.stringify(result).includes("secret"));
    } else {
      const result = h.hooks.get(first)!({ messages }, f.ctx);
      assert.ok(!JSON.stringify(result).includes("secret"));
      assert.equal(result.messages[0].content, CENSORED);
    }
    assert.deepEqual(h.hooks.get("before_provider_request")!({ payload: { raw: "secretMASK" } }, f.ctx), {});
    assert.equal(h.hooks.get("input")!({ text: "secretMASK" }, f.ctx).text, CENSORED);
    assert.equal(messages[0].content, "secretMASK", "history originals are not rewritten");
  }
});

test("integration: real native reserves retained IDs on session start/tree before new user allocation", async t => {
  const f = await fixture(t);
  const h = host();
  const policy = validateConfig({ detectors: { email: true }, sources: { toolResults: true, userMessages: true } });
  let branch: any[] = [];
  let branchReads = 0;
  const ctx = { ...f.ctx, sessionManager: { getBranch() { branchReads++; return branch; } } };
  await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: join(f.cwd, "private-policy.json"), config: policy }), loadTools });
  const first = h.hooks.get("tool_result")!({ content: [{ type: "text", text: "first@example.test" }] }, ctx);
  assert.equal(first.content[0].text, "[EMAIL_1]");
  branch = [{ type: "message", message: { role: "toolResult", content: first.content } }];
  h.hooks.get("session_start")!({}, ctx);
  assert.equal(branchReads, 2);
  const input = h.hooks.get("input")!({ text: "🙂 second@example.test" }, ctx);
  assert.equal(input.text, "🙂 [EMAIL_2]");
  const result = h.hooks.get("context_with_system")!({ messages: [branch[0].message, { role: "user", content: input.text }] }, ctx);
  assert.equal(result.messages[0].content[0].text, "[EMAIL_1]");
  assert.equal(result.messages[1].content, "🙂 [EMAIL_2]");
  assert.equal(branchReads, 2, "stable manager reservation is memoized");
  branch = [{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "[EMAIL_9]" }] } }];
  h.hooks.get("session_tree")!({}, ctx);
  assert.equal(h.hooks.get("input")!({ text: "third@example.test" }, ctx).text, "[EMAIL_10]");
  assert.equal(branchReads, 3);
  assert.equal(h.hooks.get("before_provider_request")!({ payload: {} }, ctx), undefined);
});

test("integration: real native reserves only token IDs from exempt user input after reset", async t => {
  const f = await fixture(t);
  const h = host();
  const policy = validateConfig({ detectors: { email: true }, sources: { toolResults: true, userMessages: false } });
  const ctx = { ...f.ctx, sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: "[EMAIL_1] retained@example.test" } }] } };
  await installRedaction(h.pi, { loadConfig: async () => ({ state: "active", path: join(f.cwd, "private-policy.json"), config: policy }), loadTools });
  h.hooks.get("session_start")!({}, ctx);
  const user = { role: "user", content: "[EMAIL_50] intentionally-typed@example.test" };
  assert.deepEqual(h.hooks.get("input")!({ text: user.content }, ctx), { action: "continue" });
  const output = h.hooks.get("tool_result")!({ content: [{ type: "text", text: "new@example.test" }] }, ctx);
  assert.equal(output.content[0].text, "[EMAIL_51]");
  const context = h.hooks.get("context_with_system")!({ messages: [user, { role: "toolResult", content: output.content }] }, ctx);
  assert.equal(context.messages[0], user, "exempt user message identity/text stays untouched");
  assert.equal(context.messages[1].content[0].text, "[EMAIL_51]");
  assert.equal(h.hooks.get("before_provider_request")!({ payload: {} }, ctx), undefined);
});
