import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, KeybindingsManager as HostKeys, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { offConfig } from "../src/config.ts";
import type { ExtensionConfig } from "../src/contracts.ts";
import { createPrivateConfigStore } from "../src/config-store.ts";
import { createNativeRedactor } from "../src/native.ts";
import { runSettingsCommand } from "../src/settings-command.ts";
import { createSettingsUI, encodeExact } from "../src/settings-ui.ts";

const ORIGINAL = "  synthetic-private\r\nvalue\t🙂  ";
const ALIAS = "PRIVATE_LOCAL";
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const SAVE = "\x13", CANCEL = "\x1b", TAB = "\t", ENTER = "\r";
const active = () => { const c = offConfig(); c.sources.toolResults = true; c.detectors.email = true; return c; };

async function fixture(t: TestContext, initial?: ExtensionConfig) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "redaction-settings-integration-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "config.json");
  const store = createPrivateConfigStore(path);
  if (initial) await store.save(await store.read(), initial);
  const events = new Map<string, () => void>();
  const inputListeners = new Set<Parameters<ExtensionCommandContext["ui"]["onTerminalInput"]>[0]>();
  let consumedInputs = 0;
  const calls: string[] = [], notices: string[] = [], confirmations: string[] = [], frames: string[] = [];
  const scripts: string[][] = [];
  const decisions: boolean[] = [];
  let beforeCustom: (() => Promise<void> | void) | undefined;
  let afterCustom: (() => Promise<void> | void) | undefined;
  let prompt = "unchanged synthetic ordinary prompt";
  let inCustom = false;
  const forbidden = () => { throw new Error("private settings must not call session/model/prompt APIs"); };
  const pi = {
    on(name: string, handler: () => void) { events.set(name, handler); return () => { events.delete(name); }; },
    sendMessage: forbidden, sendUserMessage: forbidden, appendEntry: forbidden, registerTool: forbidden,
  } as unknown as ExtensionAPI;
  const kb = new KeybindingsManager(TUI_KEYBINDINGS); setKeybindings(kb);
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI;
  const theme = { bold: (text: string) => `\x1b[1m${text}\x1b[22m`, fg: (_token: string, text: string) => text } as unknown as Theme;
  const ctx = {
    mode: "tui", hasUI: true,
    sessionManager: { getBranch: forbidden, appendMessage: forbidden, appendCustomEntry: forbidden },
    ui: {
      onTerminalInput(handler: Parameters<ExtensionCommandContext["ui"]["onTerminalInput"]>[0]) {
        inputListeners.add(handler); return () => { inputListeners.delete(handler); };
      },
      getEditorText: () => prompt,
      setEditorText(text: string) { assert.equal(text, prompt); assert.ok(!text.includes(ORIGINAL)); prompt = text; },
      notify(text: string) { assert.ok(!text.includes(ORIGINAL)); assert.ok(!text.includes(path)); notices.push(text); },
      async confirm(_title: string, text: string) { confirmations.push(text); assert.ok(!text.includes(ORIGINAL)); return decisions.shift() ?? true; },
      async custom(factory: (tui: TUI, theme: Theme, kb: HostKeys, done: (value: unknown) => void) => Component & { dispose?(): void }) {
        assert.equal(inCustom, false); inCustom = true;
        await beforeCustom?.();
        const keys = scripts.shift(); assert.ok(keys, "unexpected extra custom dialog");
        let component: Component & { dispose?(): void };
        let completed = false, result: unknown;
        component = factory(tui, theme, kb as HostKeys, value => { assert.equal(completed, false); completed = true; result = value; component?.dispose?.(); });
        // Exercise actual public SettingsList/Editor rendering and input, not a menu mock.
        for (const key of keys) {
          const frame = component.render(80).join("\n"); frames.push(frame);
          if (!frame.includes("Local replacement:")) assert.ok(!frame.includes(ORIGINAL));
          // Public host ordering: scoped listeners run before global handlers/components.
          const consumed = [...inputListeners].some(handler => handler(key)?.consume);
          if (consumed) consumedInputs++;
          else component.handleInput?.(key);
        }
        await afterCustom?.();
        assert.ok(completed, "dialog script must complete"); component.dispose?.(); inCustom = false;
        return result;
      },
    },
    async waitForIdle() { assert.equal(inCustom, false); calls.push("idle"); },
    async reload() { assert.equal(inCustom, false); calls.push("reload"); },
  } as unknown as ExtensionCommandContext;
  const deps = {
    store: {
      async read() { calls.push("read"); return store.read(); },
      async save(expected: Awaited<ReturnType<typeof store.read>>, draft: ExtensionConfig) { assert.equal(inCustom, false); calls.push("save"); return store.save(expected, draft); },
    },
    ui: createSettingsUI(),
    validateNative(config: ExtensionConfig) { calls.push("native"); const engine = createNativeRedactor(config); try { engine.redact(""); } finally { engine.reset(); } },
  };
  const run = async () => {
    try { await runSettingsCommand(pi, "", ctx, { summary: initial ? "active" : "inactive", config: initial ?? offConfig() }, async () => deps); }
    finally { assert.equal(inputListeners.size, 0, "private terminal guard leaked"); }
  };
  return { root, path, store, scripts, decisions, calls, notices, confirmations, frames, events, ctx, pi, deps, run, inputListeners, consumedInputs: () => consumedInputs,
    before(fn: () => Promise<void> | void) { beforeCustom = fn; }, after(fn: () => Promise<void> | void) { afterCustom = fn; } };
}

test("settings-integration: inactive actual command opens/cancels missing config without addon or creating policy", async t => {
  const f = await fixture(t);
  // Isolated source-only child exercises the default lazy loader with TEMP XDG paths only.
  const copy = join(f.root, "source-only"); await fs.mkdir(copy);
  for (const name of ["index.ts", "src", "package.json"]) await fs.cp(new URL(`../${name}`, import.meta.url), join(copy, name), { recursive: true });
  await fs.mkdir(join(copy, "node_modules/@earendil-works"), { recursive: true });
  await fs.symlink(dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")))), join(copy, "node_modules/@earendil-works/pi-tui"));
  await assert.rejects(fs.access(join(copy, "native/redaction.node")));
  const entry = pathToFileURL(join(copy, "index.ts")).href;
  const toolkit = import.meta.resolve("@earendil-works/pi-tui");
  const script = `const {default: install} = await import(${JSON.stringify(entry)});
    const commands = new Map(); const events = new Map();
    await install({registerCommand(n,c){commands.set(n,c)},on(n,h){events.set(n,h);return()=>events.delete(n)},registerTool(){throw Error('inactive tool')}});
    if(!commands.has('redaction') || events.size) throw Error('inactive registration');
    const toolkit = await import(${JSON.stringify(toolkit)});
    const kb = new toolkit.KeybindingsManager(toolkit.TUI_KEYBINDINGS);
    const inputListeners = new Set();
    const ctx={mode:'tui',hasUI:true,ui:{onTerminalInput(h){inputListeners.add(h);return()=>inputListeners.delete(h)},notify(){throw Error('unexpected notice')},getEditorText(){return ''},setEditorText(){throw Error('prompt write')},custom(factory){return new Promise(resolve=>{const c=factory({terminal:{rows:24,columns:80},requestRender(){}},{bold:s=>s,fg:(_,s)=>s},kb,resolve);c.render(80);if(![...inputListeners].some(h=>h('\\x1b')?.consume))c.handleInput('\\x1b');c.dispose?.()})}},waitForIdle(){throw Error('idle')},reload(){throw Error('reload')}};
    await commands.get('redaction').handler('',ctx); if(events.size || inputListeners.size) throw Error('leaked subscriptions');`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: new URL("../", import.meta.url), env: { ...process.env, XDG_CONFIG_HOME: f.root }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(await fs.readdir(f.root), ["source-only"]);
});

test("settings-integration: Redact > Emails + Sources > Tool results saves 600 inside 700 then reloads exactly once", async t => {
  const f = await fixture(t); f.scripts.push([ENTER, TAB, ENTER, SAVE]);
  await f.run();
  assert.deepEqual(f.calls, ["read", "idle", "native", "idle", "save", "reload"]);
  assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dirname(f.path))).mode & 0o777, 0o700);
  assert.deepEqual((await f.store.read()).config, active());
  assert.deepEqual(await fs.readdir(dirname(f.path)), ["config.json"]);
  assert.ok(f.frames.some(frame => frame.includes("Unsaved"))); assert.equal(f.events.size, 0);
});

test("settings-integration: exact private form draft cancels without writing or normal-prompt/session/model calls", async t => {
  const f = await fixture(t);
  f.scripts.push([TAB, TAB, ENTER], ["\x1bOQ", "\x01", "\x0b", paste(encodeExact(ORIGINAL)), TAB, paste(ALIAS), SAVE], [CANCEL]);
  await f.run();
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.deepEqual(f.calls, ["read"]); assert.deepEqual(f.confirmations, ["Discard pending changes?"]);
  assert.ok(f.frames.some(frame => frame.includes("#1 [masked]")));
});

test("settings-integration: exact multiline form saves through native validation even with sources off", async t => {
  const f = await fixture(t);
  f.scripts.push([TAB, TAB, ENTER], ["\x1bOQ", "\x01", "\x0b", paste(encodeExact(ORIGINAL)), TAB, paste(ALIAS), SAVE], [SAVE]);
  await f.run();
  const saved = (await f.store.read()).config;
  assert.equal(saved.literals[ORIGINAL], ALIAS); assert.deepEqual(saved.sources, offConfig().sources);
  assert.deepEqual(f.calls, ["read", "idle", "native", "idle", "save", "reload"]);
  const engine = createNativeRedactor(saved); assert.equal(engine.redact(ORIGINAL).text, ALIAS); engine.reset();
});

test("settings-integration: actual reduction confirmation declined/accepted before disk change", async t => {
  for (const accept of [false, true]) {
    const f = await fixture(t, active()); const original = await fs.readFile(f.path, "utf8");
    f.decisions.push(accept); f.scripts.push([TAB, ENTER, SAVE]); if (!accept) f.scripts.push([CANCEL]);
    await f.run();
    assert.equal(f.confirmations.filter(text => text.startsWith("Reduce protection?")).length, 1);
    assert.ok(!f.confirmations.join().includes(ORIGINAL));
    if (accept) { assert.equal((await f.store.read()).config.sources.toolResults, false); assert.equal(f.calls.at(-1), "reload"); }
    else { assert.equal(await fs.readFile(f.path, "utf8"), original); assert.ok(!f.calls.includes("save")); }
  }
});

test("settings-integration: native-incompatible rule draft refuses save despite sources off", async t => {
  const f = await fixture(t); const invalid = offConfig(); invalid.detectors.email = true;
  // JS schema accepts this alias; the actual native constructor reserves generated-token aliases.
  invalid.literals = { "synthetic-value": "[EMAIL_1]" };
  await f.store.save(await f.store.read(), invalid);
  const before = await fs.readFile(f.path, "utf8"); f.scripts.push([SAVE], [CANCEL]);
  await f.run();
  assert.ok(f.calls.includes("native")); assert.ok(!f.calls.includes("save")); assert.ok(!f.calls.includes("reload"));
  assert.equal(await fs.readFile(f.path, "utf8"), before); assert.match(f.notices[0], /scripts\/build-native\.mjs/);
  assert.ok(!f.notices.join().includes("[EMAIL_1]"));
});

test("settings-integration: external edit triggers actual stale-store conflict without overwrite/reload", async t => {
  const f = await fixture(t, active()); let edits = 0;
  f.after(async () => { if (++edits === 1) await fs.writeFile(f.path, JSON.stringify(offConfig()) + "\n", { mode: 0o600 }); });
  f.scripts.push([SAVE]); await f.run();
  assert.deepEqual((await f.store.read()).config, offConfig()); assert.ok(!f.calls.includes("reload"));
  assert.match(f.notices[0], /changed elsewhere/);
});

test("settings-integration: reload failure keeps committed private config and never reuses old context", async t => {
  const f = await fixture(t); f.scripts.push([ENTER, TAB, ENTER, SAVE]);
  f.ctx.reload = async () => {
    f.calls.push("reload");
    for (const key of Object.keys(f.ctx)) Object.defineProperty(f.ctx, key, { get() { throw new Error("old context reused"); } });
    throw new Error(ORIGINAL);
  };
  await assert.rejects(f.run(), { message: "Redaction configuration saved; reload failed. Restart Pi before relying on the saved policy." });
  assert.deepEqual((await f.store.read()).config, active()); assert.equal(f.calls.filter(call => call === "reload").length, 1);
  assert.deepEqual(f.notices, []);
});

test("settings-integration: non-TUI and unknown args never load/read actual store or render", async t => {
  for (const mode of ["rpc", "json", "print"]) {
    const f = await fixture(t); Object.assign(f.ctx, { mode });
    await runSettingsCommand(f.pi, "", f.ctx, { summary: "inactive" }, async () => { throw new Error("must not load"); });
    assert.deepEqual(f.calls, []); assert.deepEqual(await fs.readdir(f.root), []);
  }
  const f = await fixture(t);
  await runSettingsCommand(f.pi, ORIGINAL, f.ctx, { summary: "inactive" }, async () => { throw new Error("must not load"); });
  assert.deepEqual(f.notices, ["Usage: /redaction"]); assert.deepEqual(await fs.readdir(f.root), []);
});

test("settings-integration: lifecycle/operation cancellation closes actual UI and prevents late persistence", async t => {
  for (const event of ["session_shutdown", "session_before_switch", "session_tree", "signal"]) {
    const f = await fixture(t); const abort = new AbortController(); Object.assign(f.ctx, { signal: abort.signal });
    f.scripts.push([ENTER, TAB, ENTER]);
    f.after(() => { if (event === "signal") abort.abort(); else f.events.get(event)!(); });
    await f.run();
    assert.deepEqual(f.calls, ["read"]); assert.deepEqual(await fs.readdir(f.root), []); assert.equal(f.events.size, 0);
  }
});

test("settings-integration: cancellation during native validation cannot start actual store save", async t => {
  const f = await fixture(t); f.scripts.push([ENTER, TAB, ENTER, SAVE]);
  const validate = f.deps.validateNative;
  f.deps.validateNative = config => { validate(config); f.events.get("session_shutdown")!(); };
  await f.run(); assert.deepEqual(f.calls, ["read", "idle", "native"]); assert.deepEqual(await fs.readdir(f.root), []);
});

test("settings-integration: cancellation after persistence starts suppresses reload, not committed save", async t => {
  const f = await fixture(t); f.scripts.push([ENTER, TAB, ENTER, SAVE]);
  const save = f.deps.store.save;
  f.deps.store.save = async (expected, draft) => { f.events.get("session_shutdown")!(); return save(expected, draft); };
  await f.run(); assert.deepEqual((await f.store.read()).config, active()); assert.ok(!f.calls.includes("reload"));
});

test("settings-integration: scoped diagnostic guard consumes protocol keys during actual form and cleans up", async t => {
  const f = await fixture(t);
  f.scripts.push([TAB, TAB, ENTER], [paste("synthetic-private"), "\x1b[100;6u", "\x1b[68;6u", "\x1b[27;6;100~", CANCEL], [CANCEL]);
  await f.run();
  assert.equal(f.consumedInputs(), 3); assert.equal(f.inputListeners.size, 0);
  assert.deepEqual(f.notices, []); assert.deepEqual(await fs.readdir(f.root), []);
});

test("settings-integration: missing guard refuses; rejected custom host releases installed guard", async t => {
  for (const mode of ["missing", "rejected"] as const) {
    const f = await fixture(t);
    if (mode === "missing") delete (f.ctx.ui as Partial<typeof f.ctx.ui>).onTerminalInput;
    else f.ctx.ui.custom = async () => { throw new Error(ORIGINAL); };
    await f.run();
    assert.equal(f.inputListeners.size, 0); assert.deepEqual(f.calls, ["read"]);
    assert.equal(f.notices.length, 1); assert.ok(!f.notices[0].includes(ORIGINAL));
    assert.match(f.notices[0], mode === "missing" ? /terminal-input guard/ : /open redaction settings safely/);
    assert.deepEqual(await fs.readdir(f.root), []);
  }
});

test("settings-integration: known logging flags refuse controller UI before persistence and leave no files/listeners", async t => {
  const f = await fixture(t);
  const commandURL = new URL("../src/settings-command.ts", import.meta.url).href;
  const storeURL = new URL("../src/config-store.ts", import.meta.url).href;
  const uiURL = new URL("../src/settings-ui.ts", import.meta.url).href;
  const configURL = new URL("../src/config.ts", import.meta.url).href;
  const sink = join(f.root, "synthetic-terminal-sink.log");
  const script = `
    import assert from 'node:assert/strict';
    import { runSettingsCommand } from ${JSON.stringify(commandURL)};
    import { createPrivateConfigStore } from ${JSON.stringify(storeURL)};
    import { createSettingsUI } from ${JSON.stringify(uiURL)};
    import { offConfig } from ${JSON.stringify(configURL)};
    const events = new Map(); const notices = []; let listeners = 0;
    const pi = {on(name,h){events.set(name,h);return()=>events.delete(name)}};
    const forbidden = ()=>{throw Error('private render/save/reload must not start')};
    const store = createPrivateConfigStore(${JSON.stringify(f.path)});
    const ctx={mode:'tui',hasUI:true,ui:{getEditorText:()=>'',setEditorText:forbidden,
      onTerminalInput(){listeners++;return()=>listeners--},notify:text=>notices.push(text),custom:forbidden},waitForIdle:forbidden,reload:forbidden};
    await runSettingsCommand(pi,'',ctx,{summary:'inactive',config:offConfig()},async()=>({
      store:{read:()=>store.read(),save:forbidden},ui:createSettingsUI(),validateNative:forbidden}));
    assert.equal(listeners,0);assert.equal(events.size,0);assert.equal(notices.length,1);
    assert.match(notices[0],/terminal logging disabled/);
    assert.ok(!notices.join().includes(${JSON.stringify(f.path)}));
    console.log('controller logging refusal passed');`;
  for (const [debug, write] of [["1", ""], ["0", sink]]) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, PI_TUI_DEBUG: debug, PI_TUI_WRITE_LOG: write }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /controller logging refusal passed/);
  }
  assert.deepEqual(await fs.readdir(f.root), []);
});
