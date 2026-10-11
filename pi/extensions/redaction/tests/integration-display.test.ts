import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventBus, createExtensionRuntime, ExtensionRunner, initTheme } from "@earendil-works/pi-coding-agent";

const candidate = process.env.REDACTION_DISPLAY_CANDIDATE;
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const text = (component: any, width = 140) => component.render(width).join("\n").replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
const canary = "synthetic-private";
const alias = "PRIVATE_CONTACT";
const hostDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { loadExtensions } = await import(join(hostDir, "core/extensions/loader.js"));

async function setup(t: any, order: string[], mode = "protected") {
  const cwd = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "pi-combined-display-")));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const config = { literals: mode === "collision" ? { operation: "path" } : mode === "scanner-metadata" ? { secret: "cretMASK" } : { [canary]: alias }, detectors: { email: true }, sources: { toolResults: mode !== "unprotected" } };
  const redactionWrapper = join(cwd, "redaction.ts");
  await fsp.writeFile(redactionWrapper, `import install from ${JSON.stringify(source)}; import {createFileSession} from ${JSON.stringify(fileURLToPath(new URL("../src/file-tools.ts", import.meta.url)))}; import {validateConfig} from ${JSON.stringify(fileURLToPath(new URL("../src/config.ts", import.meta.url)))}; export default pi => install(pi,{loadConfig:async()=>({state:${JSON.stringify(mode === "inactive" ? "inactive" : "active")},path:${JSON.stringify(join(cwd,"policy.json"))},config:validateConfig(${JSON.stringify(config)})})${mode === "failure" ? ',loadTools:async()=>{throw Error("INIT_CANARY")}' : mode === "scanner-metadata" ? `,createFileSession: options => { const session=createFileSession(options); return {...session,async write(input){const result=await session.write(input);result.redactionDisplay.before="secretMASK";return result;}};}` : ""}});`);
  const displayWrapper = join(cwd, "display.ts");
  if (order.includes("display")) await fsp.writeFile(displayWrapper, `import {registerToolDisplayOverrides} from ${JSON.stringify(join(candidate!, "src/tool-overrides.ts"))}; import {DEFAULT_TOOL_DISPLAY_CONFIG} from ${JSON.stringify(join(candidate!, "src/types.ts"))}; import {resetDisposed,disposeAll} from ${JSON.stringify(join(candidate!, "src/disposable.ts"))}; export default pi => {resetDisposed(); pi.on("session_shutdown",()=>disposeAll()); ${mode === "disabled-display" ? "return;" : ""} const config={...DEFAULT_TOOL_DISPLAY_CONFIG,registerToolOverrides:{...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,read:false,edit:false,write:false}}; registerToolDisplayOverrides(${mode === "legacy-display" ? "{...pi,registerToolRenderer:undefined}" : "pi"},()=>config); };`);
  const runtime = createExtensionRuntime();
  const loaded = await loadExtensions(order.map(name => name === "redaction" ? redactionWrapper : displayWrapper), cwd, createEventBus(), runtime);
  assert.deepEqual(loaded.errors, []);
  const manager = { getBranch: () => [] };
  const runner = new ExtensionRunner(loaded.extensions, runtime, cwd, manager as any, {} as any);
  return { cwd, runner, loaded, ctx: { cwd, sessionManager: manager, ui: { notify() {} } } };
}

async function guardedRender(fn: () => void | Promise<void>) {
  const originals: Array<[any, string, any]> = [];
  let calls = 0;
  for (const [object, keys] of [[fs, ["readFileSync", "readFile", "openSync", "open", "statSync", "lstatSync", "realpathSync", "existsSync", "readdirSync", "writeFileSync", "renameSync", "unlinkSync", "mkdirSync"]], [fsp, ["readFile", "open", "stat", "lstat", "realpath", "readdir", "writeFile", "rename", "unlink", "mkdir"]]] as const) {
    for (const key of keys) { const target = object as any; originals.push([target, key, target[key]]); target[key] = () => { calls++; throw Error("RENDER_FS_CANARY"); }; }
  }
  syncBuiltinESMExports();
  try { await fn(); assert.equal(calls, 0); }
  finally { for (const [object, key, value] of originals) object[key] = value; syncBuiltinESMExports(); }
}

for (const order of [["redaction", "display"], ["display", "redaction"]]) {
  test(`integration-display: real Pi loader/runner ${order.join(" -> ")} sole execution, sanitized replay and no-read render`, { skip: !candidate }, async t => {
    initTheme("dark", false);
    const f = await setup(t, order);
    for (const name of ["read", "edit", "write"]) {
      const registrations = f.loaded.extensions.flatMap((ext: any) => Array.from(ext.tools.values()).filter((entry: any) => entry.definition.name === name));
      assert.equal(registrations.length, 1);
      assert.match((registrations[0] as any).sourceInfo.path, /redaction\.ts$/);
      assert.equal(f.runner.getToolDefinition(name)?.execute, (registrations[0] as any).definition.execute);
      const cold = f.runner.resolveToolRenderers(name, () => undefined)!;
      assert.equal(typeof cold.renderResult, "function");
      assert.equal("execute" in cold, false);
    }
    const rawName = `${canary}.txt`;
    await fsp.writeFile(join(f.cwd, rawName), `owner ${canary}\nbackup person@fixture.invalid\ncontext ${canary}\n`);
    const execute = async (name: string, args: any): Promise<any> => {
      const result = await f.runner.getToolDefinition(name)!.execute("id", args, undefined, undefined, f.ctx as any);
      const filtered = await f.runner.emitToolResult({ type: "tool_result", toolCallId: "id", toolName: name, input: args, ...result } as any);
      const final = { ...result, ...filtered };
      const redaction = f.loaded.extensions.find((ext: any) => ext.path.endsWith("redaction.ts"));
      const contextHook = redaction.handlers.get("context_with_system")[0];
      const contextResult = await contextHook({ messages: [{ role: "toolResult", content: final.content, details: final.details }] }, f.ctx);
      assert.doesNotMatch(JSON.stringify(contextResult), /synthetic-private|synthetic-contact@example\.invalid|person@fixture\.invalid/);
      assert.doesNotMatch(JSON.stringify(final), /synthetic-private|synthetic-contact@example\.invalid|person@fixture\.invalid/);
      return final;
    };
    const read = await execute("read", { path: `${alias}.txt` });
    assert.equal(read.details.redactionDisplay.operation, "read");
    assert.equal(read.details.redactionDisplay.after, undefined);
    const edit = await execute("edit", { path: `${alias}.txt`, edits: [{ oldText: `owner ${alias}`, newText: `primary ${alias}` }, { oldText: "backup", newText: "secondary" }] });
    assert.match(edit.details.redactionDisplay.before, /context PRIVATE_CONTACT/);
    const write = await execute("write", { path: `${alias}.txt`, content: `${alias}\n${read.content[0].text.match(/\[EMAIL_\d+\]/)![0]}\n` });
    assert.equal(write.details.redactionDisplay.fileExistedBeforeWrite, true);
    assert.equal(await fsp.readFile(join(f.cwd, rawName), "utf8"), `${canary}\nperson@fixture.invalid\n`);
    const failure = await execute("edit", { path: `${alias}.txt`, edits: [{ oldText: "missing", newText: "bad" }] });
    assert.equal(failure.isError, true);
    assert.doesNotMatch(JSON.stringify(failure), /missing|bad/);
    let renderExecutions = 0;
    const definitions = ["read", "edit", "write"].map(name => f.runner.getToolDefinition(name)!);
    const executors = definitions.map(def => def.execute);
    definitions.forEach(def => { def.execute = async () => { renderExecutions++; throw Error("RENDER_EXECUTE_CANARY"); }; });
    await guardedRender(() => {
      for (const [name, result] of [["read", read], ["edit", edit], ["write", write], ["edit", failure]] as const) {
        const renderer = f.runner.resolveToolRenderers(name, () => undefined)!;
        const context = { args: { path: "MODEL_PATH", content: "ARG_CONTENT_CANARY", edits: [{ oldText: "ARG_CONTENT_CANARY", newText: "ARG_CONTENT_CANARY" }] }, cwd: f.cwd, state: {}, argsComplete: true };
        assert.doesNotMatch(text(renderer.renderCall!(context.args, theme as any, context as any)), /ARG_CONTENT_CANARY/);
        for (const expanded of [false, true]) for (const isPartial of [false, true]) {
          const replay = JSON.parse(JSON.stringify(result));
          const component = renderer.renderResult!(replay, { expanded, isPartial }, theme as any, context as any);
          for (const width of [20, 60, 140]) { assert.doesNotMatch(text(component, width), /synthetic-private|synthetic-contact@example\.invalid|person@fixture\.invalid|ARG_CONTENT_CANARY/); component.invalidate(); }
        }
      }
    });
    assert.equal(renderExecutions, 0);
    definitions.forEach((def, index) => { def.execute = executors[index]; });
    const rendered = text(f.runner.resolveToolRenderers("write", () => undefined)!.renderResult!(write as any, { expanded: true, isPartial: false }, theme as any, {} as any));
    t.diagnostic(`sanitized completed write preview:\n${rendered}`);
    await f.runner.emit({ type: "session_shutdown", reason: "reload" } as any);
  });
}

test("integration-display: missing/disabled components, unprotected sources, initialization failure and resolver replacement", { skip: !candidate }, async t => {
  for (const [order, mode] of [[["redaction"], "protected"], [["display"], "protected"], [["display", "redaction"], "inactive"], [["display", "redaction"], "unprotected"], [["display", "redaction"], "failure"], [["display", "redaction"], "disabled-display"]] as Array<[string[], string]>) {
    const f = await setup(t, order, mode);
    const owner = f.runner.getToolDefinition("write");
    assert.equal(Boolean(owner), order.includes("redaction") && ["protected", "disabled-display"].includes(mode));
    const renderer = f.runner.resolveToolRenderers("write", () => undefined);
    assert.equal(Boolean(renderer), order.includes("display") && mode !== "disabled-display");
    if (renderer) assert.equal(text(renderer.renderResult!({ content: [{ type: "text", text: "Safe text" }], details: undefined }, { expanded: true, isPartial: false }, theme as any, { args: { content: "ARG_CONTENT_CANARY" } } as any)), "Safe text");
    if (mode === "failure") assert.equal((await f.runner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "id", input: {} } as any))?.block, true);
    // Package cleanup must disable an old resolver even without replacing the host runner.
    const display = f.loaded.extensions.find((ext: any) => ext.path.endsWith("display.ts"));
    if (display) {
      await f.runner.emit({ type: "session_shutdown", reason: "reload" } as any);
      assert.equal(f.runner.resolveToolRenderers("write", () => undefined), undefined);
      const fresh = await setup(t, ["display", "redaction"]);
      assert.ok(fresh.runner.resolveToolRenderers("write", () => undefined));
      assert.equal(f.runner.resolveToolRenderers("write", () => undefined), undefined);
    }
    await f.runner.emit({ type: "session_shutdown", reason: "reload" } as any);
  }
});

test("integration-display: committed write stays successful when metadata transport fails", async t => {
  const { installRedaction } = await import("../src/index.ts");
  const { createFileSession } = await import("../src/file-tools.ts");
  const { validateConfig } = await import("../src/config.ts");
  const cwd = await fsp.realpath(await fsp.mkdtemp(join(tmpdir(), "pi-display-transport-")));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));
  const tools = new Map<string, any>();
  await installRedaction({ registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, on() {} } as any, {
    loadConfig: async () => ({ state: "active", path: join(cwd, "policy.json"), config: validateConfig({ literals: { "synthetic-private": "PRIVATE_VALUE" }, sources: { toolResults: true } }) }),
    createFileSession(options) {
      const session = createFileSession(options);
      return { ...session, async write(input) {
        const result = await session.write(input);
        Object.defineProperty(result, "redactionDisplay", { get() { throw Error("DISPLAY_TRANSPORT_CANARY"); } });
        return result;
      } };
    },
  });
  const result = await tools.get("write").execute("id", { path: "new.txt", content: "synthetic-private" }, undefined, undefined, { cwd });
  assert.equal(result.isError, undefined);
  assert.equal(result.details, undefined);
  assert.equal(result.content[0].text, "PRIVATE_VALUE");
  assert.equal(await fsp.readFile(join(cwd, "new.txt"), "utf8"), "synthetic-private");
});

test("integration-display: owned metadata collision drops details through real native/Pi merging without latching", async t => {
  const f = await setup(t, ["redaction"], "collision");
  const write = f.runner.getToolDefinition("write")!;
  const result = await write.execute("id", { path: "new.txt", content: "hello" }, undefined, undefined, f.ctx as any);
  assert.equal(result.isError, undefined);
  assert.ok(result.details);
  const event = { type: "tool_result", toolCallId: "id", toolName: "write", input: { path: "new.txt", content: "hello" }, ...result } as any;
  const filtered = await f.runner.emitToolResult(event);
  const merged = { ...result, ...filtered };
  assert.equal(merged.details, null, "explicit null replaces owned metadata in Pi's result merge");
  assert.equal(merged.isError, undefined);
  assert.equal(merged.content[0].type, "text");
  assert.equal((merged.content[0] as any).text, "hello");
  assert.equal(await fsp.readFile(join(f.cwd, "new.txt"), "utf8"), "hello");
  // Both a repeated original and the filtered historical/replayed result remain safe.
  assert.equal((await f.runner.emitToolResult(event))?.isError, undefined);
  assert.equal((await f.runner.emitToolResult({ ...event, ...merged }))?.isError, undefined);
  const ext = f.loaded.extensions[0];
  const history = await ext.handlers.get("context_with_system")[0]({ messages: [{ role: "toolResult", content: merged.content, details: merged.details }] }, f.ctx);
  assert.equal(history.messages[0].details, null);
  assert.equal(history.messages[0].content[0].text, "hello");
  const next = await write.execute("next", { path: "new.txt", content: "still works" }, undefined, undefined, f.ctx as any);
  const nextFiltered = await f.runner.emitToolResult({ ...event, toolCallId: "next", ...next });
  assert.equal(nextFiltered?.isError, undefined);
  assert.equal(nextFiltered?.details, null);
  assert.equal(await fsp.readFile(join(f.cwd, "new.txt"), "utf8"), "still works");
  assert.equal(await ext.handlers.get("before_provider_request")[0]({}, f.ctx), undefined);
});

test("integration-display: unmarked arbitrary, cloned and historical ambiguous details remain strict", async t => {
  for (const kind of ["arbitrary", "clone", "history"]) {
    const f = await setup(t, ["redaction"], "collision");
    const write = f.runner.getToolDefinition("write")!;
    const original = await write.execute("id", { path: "new.txt", content: "hello" }, undefined, undefined, f.ctx as any);
    const details = kind === "arbitrary" ? { operation: "write", path: "new.txt" } : JSON.parse(JSON.stringify(original.details));
    const ext = f.loaded.extensions[0];
    if (kind === "history") {
      const result = await ext.handlers.get("context_with_system")[0]({ messages: [{ role: "toolResult", content: original.content, details }] }, f.ctx);
      assert.match(result.messages[0].content, /REDACTION_UNAVAILABLE/);
    } else {
      const result = await f.runner.emitToolResult({ type: "tool_result", toolCallId: "id", toolName: "write", input: {}, ...original, details } as any);
      assert.equal(result?.isError, true);
      assert.equal(result?.details, null);
      assert.match((result?.content?.[0] as any).text, /REDACTION_UNAVAILABLE/);
    }
    assert.deepEqual(await ext.handlers.get("before_provider_request")[0]({}, f.ctx), {});
    assert.equal((await write.execute("next", { path: "other.txt", content: "hello" }, undefined, undefined, f.ctx as any)).isError, true);
    await assert.rejects(fsp.access(join(f.cwd, "other.txt")));
  }
});

test("integration-display: actual native failure inside marked metadata remains sticky and fail-closed", async t => {
  const f = await setup(t, ["redaction"], "scanner-metadata");
  const write = f.runner.getToolDefinition("write")!;
  const original = await write.execute("id", { path: "new.txt", content: "hello" }, undefined, undefined, f.ctx as any);
  assert.equal(original.isError, undefined);
  assert.equal(await fsp.readFile(join(f.cwd, "new.txt"), "utf8"), "hello");
  // The trusted test adapter supplies a value that triggers the real native alias-boundary refusal.
  const result = await f.runner.emitToolResult({ type: "tool_result", toolCallId: "id", toolName: "write", input: {}, ...original } as any);
  assert.equal(result?.isError, true);
  assert.equal(result?.details, null);
  assert.match((result?.content?.[0] as any).text, /REDACTION_UNAVAILABLE/);
  assert.doesNotMatch(JSON.stringify(result), /secretMASK/);
  const ext = f.loaded.extensions[0];
  assert.deepEqual(await ext.handlers.get("before_provider_request")[0]({}, f.ctx), {});
  assert.equal((await write.execute("next", { path: "other.txt", content: "hello" }, undefined, undefined, f.ctx as any)).isError, true);
  await assert.rejects(fsp.access(join(f.cwd, "other.txt")));
});

for (const [order, mode] of [[["redaction"], "protected"], [["display", "redaction"], "disabled-display"], [["display", "redaction"], "legacy-display"]] as Array<[string[], string]>) {
  test(`integration-display: protected fallback ${mode}/${order.join("+")} cannot read raw pending or replay context`, { skip: order.includes("display") && !candidate }, async t => {
    initTheme("dark", false);
    const f = await setup(t, order, mode);
    await fsp.writeFile(join(f.cwd, "unobserved.txt"), "visible\nRAW_UNSEEN_CONTEXT_CANARY\n");
    let executeCalls = 0;
    let invalidations = 0;
    const definitions = ["read", "edit", "write"].map(name => f.runner.getToolDefinition(name)!);
    const originalExecute = definitions.map(def => def.execute);
    const args = { path: "unobserved.txt", edits: [{ oldText: "visible", newText: "changed" }], content: "ARG_CONTENT_CANARY" };
    for (const def of definitions) {
      assert.equal(def.renderShell, "default", "never inherit self-framing preview shells");
      assert.equal(def.renderResult, undefined);
      assert.equal(f.runner.resolveToolRenderers(def.name, () => def), def, "actual base definition is selected without a display resolver");
      def.execute = async () => { executeCalls++; throw Error("EXECUTION_CANARY"); };
    }
    await guardedRender(async () => {
      for (const def of definitions) for (const argsComplete of [false, true]) for (const isError of [false, true]) {
        const context = { cwd: f.cwd, args, argsComplete, isError, isPartial: !argsComplete, expanded: true, state: {}, invalidate() { invalidations++; } };
        const component = def.renderCall!(JSON.parse(JSON.stringify(args)), theme as any, context as any);
        assert.match(text(component), new RegExp(def.name));
        assert.doesNotMatch(text(component), /RAW_UNSEEN_CONTEXT_CANARY|ARG_CONTENT_CANARY|visible|changed/);
        await new Promise(resolve => setTimeout(resolve, 10));
        component.invalidate();
        assert.doesNotMatch(text(component), /RAW_UNSEEN_CONTEXT_CANARY|ARG_CONTENT_CANARY/);
        assert.equal("preview" in component, false);
      }
      // Keep guards installed after complete arguments to catch asynchronous preview completions.
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.equal(executeCalls, 0);
    assert.equal(invalidations, 0);
    definitions.forEach((def, index) => { def.execute = originalExecute[index]; });
    const refused = await f.runner.getToolDefinition("edit")!.execute("id", args, undefined, undefined, f.ctx as any);
    assert.equal(refused.isError, true, "pending rendering never authorizes an unobserved edit");
    assert.equal(await fsp.readFile(join(f.cwd, "unobserved.txt"), "utf8"), "visible\nRAW_UNSEEN_CONTEXT_CANARY\n");
    await f.runner.emit({ type: "session_shutdown", reason: "reload" } as any);
  });
}
