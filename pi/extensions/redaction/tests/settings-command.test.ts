import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PrivateConfigSnapshot } from "../src/menu-contracts.ts";
import type { MenuOutcome } from "../src/settings-ui.ts";
import { offConfig } from "../src/config.ts";
import { cloneDraft } from "../src/settings-model.ts";
import { runSettingsCommand } from "../src/settings-command.ts";

const SECRET = "synthetic-secret-never-notify";
function fixture() {
  const events = new Map<string, () => void>();
  const calls: string[] = [];
  const notices: string[] = [];
  const snapshot: PrivateConfigSnapshot = { path: "/synthetic/private/config.json", config: offConfig(), revision: "opaque-secret-revision" };
  let prompt = "preserved main draft";
  let outcome: MenuOutcome = { kind: "cancel" };
  const pi = { on(name: string, handler: () => void) { events.set(name, handler); return () => events.delete(name); } } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", hasUI: true, signal: undefined,
    ui: { notify(text: string) { notices.push(text); }, getEditorText() { return prompt; }, setEditorText(text: string) { assert.equal(text, prompt); prompt = text; calls.push("prepare-prompt"); } },
    async waitForIdle() { calls.push("idle"); }, async reload() { calls.push("reload"); },
  } as unknown as ExtensionCommandContext;
  const deps = {
    store: { async read() { calls.push("read"); return snapshot; }, async save(expected: PrivateConfigSnapshot, draft: typeof snapshot.config) { calls.push("save"); assert.equal(expected, snapshot); return { ...snapshot, config: cloneDraft(draft) }; } },
    ui: {
      async menu(_ctx: ExtensionCommandContext, _draft: typeof snapshot.config) { calls.push("menu-closed"); return outcome; },
      async form() { calls.push("form-closed"); return undefined as [string, string] | undefined; },
      async confirm(_ctx: ExtensionCommandContext, message: string) { assert.ok(!message.includes(SECRET)); calls.push("confirm-closed"); return true; },
    },
    async validateNative() { calls.push("native"); },
  };
  const run = () => runSettingsCommand(pi, "", ctx, { summary: "inactive", config: offConfig() }, async () => deps);
  return { events, calls, notices, snapshot, pi, ctx, deps, run, setOutcome(value: MenuOutcome) { outcome = value; } };
}
test("settings-command: open/cancel creates nothing and leaves main prompt intact", async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.calls, ["read", "prepare-prompt", "menu-closed"]);
  assert.equal(f.notices.length, 0); assert.equal(f.events.size, 0);
});
test("settings-command: readonly modes and unknown args refuse before loading/private reads", async () => {
  for (const mode of ["rpc", "json", "print", undefined, "tui"]) {
    const f = fixture();
    Object.assign(f.ctx, { mode, hasUI: mode !== "tui" });
    await runSettingsCommand(f.pi, "", f.ctx, { summary: "inactive" }, async () => { throw new Error("must not load"); });
    assert.equal(f.calls.length, 0); assert.equal(f.events.size, 0);
    assert.match(f.notices[0], /local TUI/);
  }
  const f = fixture();
  await runSettingsCommand(f.pi, SECRET, f.ctx, { summary: "inactive" }, async () => { throw new Error("must not load"); });
  assert.deepEqual(f.notices, ["Usage: /redaction"]); assert.equal(f.events.size, 0);
});
test("settings-command: Save closes UI, waits idle, validates rules even with sources off, saves then reloads", async () => {
  const f = fixture(); f.snapshot.config.literals = { [SECRET]: "PRIVATE_ONE" }; f.setOutcome({ kind: "save" });
  await f.run();
  assert.deepEqual(f.calls, ["read", "prepare-prompt", "menu-closed", "idle", "native", "idle", "save", "reload"]);
  assert.deepEqual(f.notices, []); assert.equal(f.events.size, 0);
  const off = fixture(); off.setOutcome({ kind: "save" }); await off.run();
  assert.ok(!off.calls.includes("native"));
});
test("settings-command: committed durability/cleanup warnings notify generically before one reload without retry", async () => {
  for (const warnings of [["durability"], ["cleanup"], ["durability", "cleanup"], []] as const) {
    const f = fixture(); f.setOutcome({ kind: "save" });
    f.deps.store.save = async (_expected, draft) => {
      f.calls.push("save"); return { ...f.snapshot, config: cloneDraft(draft), warnings };
    };
    f.ctx.ui.notify = (text, type) => {
      assert.equal(type, "warning"); f.notices.push(text); f.calls.push("warning");
      assert.ok(!text.includes(SECRET)); assert.ok(!text.includes(f.snapshot.path)); assert.ok(!text.includes(f.snapshot.revision));
      assert.match(text, /saved.*storage warning/); assert.ok(!/unchanged|unsaved|rolled back/i.test(text));
    };
    await f.run();
    assert.equal(f.calls.filter(call => call === "save").length, 1);
    assert.equal(f.calls.filter(call => call === "reload").length, 1);
    assert.deepEqual(f.calls.slice(-(warnings.length ? 3 : 2)), warnings.length ? ["save", "warning", "reload"] : ["save", "reload"]);
    assert.equal(f.notices.length, warnings.length ? 1 : 0);
  }
});
test("settings-command: committed warning notification failure does not retry or prevent reload", async () => {
  const f = fixture(); f.setOutcome({ kind: "save" });
  f.deps.store.save = async (_expected, draft) => { f.calls.push("save"); return { ...f.snapshot, config: draft, warnings: ["cleanup"] }; };
  f.ctx.ui.notify = () => { throw new Error(SECRET); };
  await f.run(); assert.deepEqual(f.calls.slice(-2), ["save", "reload"]);
});
test("settings-command: missing/bad native backend refuses rule save with value-free actionable error", async () => {
  const f = fixture(); f.snapshot.config.detectors.email = true;
  let visits = 0;
  f.deps.ui.menu = async () => ++visits === 1 ? { kind: "save" } : { kind: "cancel" };
  f.deps.validateNative = async () => { throw new Error(SECRET); };
  await f.run();
  assert.ok(!f.calls.includes("save")); assert.ok(!f.calls.includes("reload"));
  assert.match(f.notices[0], /scripts\/build-native\.mjs/); assert.ok(!f.notices.join().includes(SECRET));
});
test("settings-command: add/edit/delete are draft-only, dirty cancel confirms once", async () => {
  const f = fixture();
  const outcomes: MenuOutcome[] = [{ kind: "add" }, { kind: "edit", index: 0 }, { kind: "delete", index: 0 }, { kind: "add" }, { kind: "cancel" }];
  let forms = 0;
  f.deps.ui.menu = async (_ctx, draft) => {
    if (outcomes[0].kind === "edit") assert.equal(draft.literals[SECRET], "PRIVATE_ONE");
    if (outcomes[0].kind === "add" && forms === 2) assert.equal(Object.keys(draft.literals).length, 0);
    return outcomes.shift()!;
  };
  f.deps.ui.form = async () => ++forms === 2 ? [SECRET, "PRIVATE_TWO"] : [SECRET, "PRIVATE_ONE"];
  await f.run();
  assert.equal(f.calls.filter(c => c === "confirm-closed").length, 2, "delete and discard only");
  assert.ok(!f.calls.includes("save")); assert.deepEqual(f.snapshot.config, offConfig());
});
test("settings-command: one reduction confirmation considers runtime as well as saved policy", async () => {
  const f = fixture(); f.setOutcome({ kind: "save" });
  const runtime = offConfig(); runtime.sources.toolResults = true; runtime.detectors.email = true;
  await runSettingsCommand(f.pi, "", f.ctx, { summary: "active", config: runtime }, async () => f.deps);
  assert.equal(f.calls.filter(c => c === "confirm-closed").length, 1);
  assert.deepEqual(f.calls.slice(-4), ["confirm-closed", "idle", "save", "reload"]);
});
test("settings-command: schema failure does not validate native or save", async () => {
  const f = fixture(); let visits = 0;
  f.deps.ui.menu = async (_ctx, draft) => {
    if (++visits === 1) { draft.literals = { [SECRET]: "" }; return { kind: "save" }; }
    return { kind: "cancel" };
  };
  await f.run(); assert.ok(!f.calls.includes("native")); assert.ok(!f.calls.includes("save"));
  assert.ok(!f.notices.join().includes(SECRET));
});
test("settings-command: invalid/unsafe reads and conflict/busy/io saves do not expose private errors or reload", async () => {
  for (const code of ["invalid", "unsafe", "conflict", "busy", "io", "unknown", "__proto__"]) {
    const f = fixture(); f.setOutcome({ kind: "save" });
    const error = Object.assign(new Error(SECRET), { code, cause: SECRET });
    if (code === "invalid" || code === "unsafe") f.deps.store.read = async () => { throw error; };
    else f.deps.store.save = async () => { throw error; };
    await f.run(); assert.ok(!f.calls.includes("reload")); assert.equal(f.notices.length, 1);
    assert.ok(!f.notices.join().includes(SECRET)); assert.equal(f.events.size, 0);
  }
});
test("settings-command: session cancellation during each awaited phase prevents a late save/reload", async () => {
  for (const phase of ["load", "read", "menu", "form", "confirm", "idle", "native"]) {
    const f = fixture(); f.snapshot.config.detectors.email = true;
    f.setOutcome(phase === "form" ? { kind: "add" } : { kind: "save" });
    const stop = () => f.events.get("session_shutdown")!();
    const load = async () => { if (phase === "load") stop(); return f.deps; };
    if (phase === "read") f.deps.store.read = async () => { stop(); return f.snapshot; };
    if (phase === "menu") f.deps.ui.menu = async () => { stop(); return { kind: "save" }; };
    if (phase === "form") f.deps.ui.form = async () => { stop(); return [SECRET, "PRIVATE_ONE"]; };
    if (phase === "confirm") {
      f.snapshot.config.sources.toolResults = true;
      f.deps.ui.menu = async (_ctx, draft) => { draft.sources.toolResults = false; return { kind: "save" }; };
      f.deps.ui.confirm = async () => { stop(); return true; };
    }
    if (phase === "idle") f.ctx.waitForIdle = async () => { stop(); };
    if (phase === "native") f.deps.validateNative = async () => { stop(); };
    await runSettingsCommand(f.pi, "", f.ctx, { summary: "inactive" }, load);
    assert.ok(!f.calls.includes("save"), phase); assert.ok(!f.calls.includes("reload"), phase);
    assert.equal(f.events.size, 0);
  }
});
test("settings-command: cancellation after save begins cannot revoke persistence but prevents stale reload", async () => {
  const f = fixture(); f.setOutcome({ kind: "save" });
  f.deps.store.save = async (_expected, draft) => { f.calls.push("save-started"); f.events.get("session_shutdown")!(); return { ...f.snapshot, config: draft }; };
  await f.run(); assert.ok(f.calls.includes("save-started")); assert.ok(!f.calls.includes("reload"));
});
test("settings-command: aborted operation signal and session-switch/tree events cancel", async () => {
  for (const event of ["session_before_switch", "session_tree", "signal"]) {
    const f = fixture(); const signal = new AbortController(); Object.assign(f.ctx, { signal: signal.signal });
    f.deps.ui.menu = async () => { if (event === "signal") signal.abort(); else f.events.get(event)!(); return { kind: "save" }; };
    await f.run(); assert.ok(!f.calls.includes("save"));
  }
});
test("settings-command: reload failure is generic and does not reuse old context after await", async () => {
  const f = fixture(); f.setOutcome({ kind: "save" });
  f.ctx.reload = async () => {
    for (const key of Object.keys(f.ctx)) Object.defineProperty(f.ctx, key, { get() { throw new Error("old context reused"); } });
    throw new Error(SECRET);
  };
  await assert.rejects(f.run(), { message: "Redaction configuration saved; reload failed. Restart Pi before relying on the saved policy." });
  assert.equal(f.notices.length, 0);
});
