import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { KeybindingsManager, TUI_KEYBINDINGS, TuiMainScreen, matchesKey, setKeybindings } from "@earendil-works/pi-tui";
import type { Component, Terminal } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, KeybindingsManager as HostKeys, Theme } from "@earendil-works/pi-coding-agent";
import { offConfig } from "../src/config.ts";
import { createSettingsUI } from "../src/settings-ui.ts";

const secret = "synthetic-original-debug-guard";
const theme = { bold: (text: string) => `\x1b[1m${text}\x1b[22m`, fg: (_token: string, text: string) => text } as unknown as Theme;
const diagnosticKeys = ["\x1b[100;6u", "\x1b[68;6u", "\x1b[27;6;100~"];

test("settings-privacy: actual TuiMainScreen listeners intercept diagnostics before global debug and clean up", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-redaction-settings-diagnostics-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const outcome of ["cancel", "save", "abort", "dispose"] as const) {
    const sink = join(temporary, `${outcome}.log`);
    let input: (data: string) => void = () => { throw new Error("terminal not started"); };
    const terminal: Terminal = {
      rows: 24, columns: 100, kittyProtocolActive: true,
      start(handler) { input = handler; }, stop() {}, async drainInput() {},
      write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
      clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    };
    const tui = new TuiMainScreen(terminal, false, temporary);
    t.after(() => tui.stop());
    const kb = new KeybindingsManager(TUI_KEYBINDINGS); setKeybindings(kb);
    const ordinary: Component = { render: () => ["ordinary screen"], invalidate() {} };
    tui.addChild(ordinary);
    let diagnostics = 0;
    tui.onDebug = () => { diagnostics++; appendFileSync(sink, tui.render(100).join("\n") + "\n"); };
    tui.start();
    input(diagnosticKeys[0]); assert.equal(diagnostics, 1, "positive control: host-global handler runs");
    let active: (Component & { dispose?(): void }) | undefined;
    let closeHost: (value: unknown) => void = () => {};
    let listeners = 0;
    const ctx = { ui: {
      notify() { throw new Error("unexpected notification"); },
      onTerminalInput(handler: Parameters<ExtensionCommandContext["ui"]["onTerminalInput"]>[0]) {
        const remove = tui.addInputListener(handler); listeners++;
        return () => { listeners--; remove(); };
      },
      custom(factory: any) {
        return new Promise(resolve => {
          closeHost = value => { active?.dispose?.(); tui.clear(); tui.addChild(ordinary); tui.setFocus(ordinary); resolve(value); };
          active = factory(tui, theme, kb as HostKeys, closeHost);
          tui.clear(); tui.addChild(active!); tui.setFocus(active!);
        });
      },
    } } as unknown as ExtensionCommandContext;
    const abort = new AbortController();
    const pending = createSettingsUI().form(ctx, [secret, "PRIVATE_ACCOUNT"], abort.signal);
    assert.equal(listeners, 1);
    assert.ok(tui.render(100).join("\n").includes(secret), "private form is really visible to host rendering");
    tui.renderNow();
    for (const key of diagnosticKeys) {
      assert.ok(matchesKey(key, "shift+ctrl+d")); input(key);
    }
    assert.equal(diagnostics, 1, "listener must run before the actual global diagnostic handler");
    assert.ok(!readFileSync(sink, "utf8").includes(secret));
    if (outcome === "abort") abort.abort();
    else if (outcome === "dispose") { active!.dispose?.(); closeHost(undefined); }
    else input(outcome === "save" ? "\x13" : "\x1b");
    assert.deepEqual(await pending, outcome === "save" ? [secret, "PRIVATE_ACCOUNT"] : undefined);
    assert.equal(listeners, 0);
    input(diagnosticKeys[0]); assert.equal(diagnostics, 2, "diagnostics restored after private UI closes");
    assert.ok(!readFileSync(sink, "utf8").includes(secret));
    tui.stop();
  }
});

test("settings-privacy: missing, invalid or throwing public input guard refuses private UI safely", async () => {
  for (const api of [undefined, () => undefined, () => { throw new Error(secret); }]) {
    const notices: string[] = [];
    const ctx = { ui: {
      onTerminalInput: api, notify: (message: string) => notices.push(message),
      custom() { throw new Error("private custom UI must not open"); },
    } } as unknown as ExtensionCommandContext;
    const ui = createSettingsUI(); const signal = new AbortController().signal;
    assert.deepEqual(await ui.menu(ctx, offConfig(), offConfig(), "inactive", signal), { kind: "cancel" });
    assert.equal(await ui.form(ctx, [secret, "PRIVATE_ACCOUNT"], signal), undefined);
    assert.equal(notices.length, 2); assert.match(notices[0], /terminal-input guard/);
    assert.ok(!notices.join().includes(secret));
  }
});

test("settings-privacy: rejected custom UI and cancellation before a deferred factory release the guard", async () => {
  let listeners = 0;
  let factory: (() => unknown) | undefined;
  const abort = new AbortController();
  const ctx = { ui: {
    onTerminalInput() { listeners++; return () => { listeners--; }; }, notify() {},
    custom(callback: any) {
      factory = () => callback({}, theme, {}, () => {});
      return Promise.reject(new Error("synthetic host failure"));
    },
  } } as unknown as ExtensionCommandContext;
  await assert.rejects(createSettingsUI().form(ctx, [secret, "PRIVATE_ACCOUNT"], abort.signal), /synthetic host failure/);
  assert.equal(listeners, 0);
  let rejectPending: (error: unknown) => void = () => {};
  ctx.ui.custom = (callback: any) => new Promise((_resolve, reject) => {
    rejectPending = reject; factory = () => callback({}, theme, {}, () => {});
  });
  const pending = createSettingsUI().form(ctx, [secret, "PRIVATE_ACCOUNT"], abort.signal);
  assert.equal(listeners, 1); abort.abort(); assert.equal(listeners, 0);
  try { factory!(); } catch (error) { rejectPending(error); }
  await assert.rejects(pending, /settings canceled/); assert.equal(listeners, 0);
});

test("settings-privacy: known logging flags refuse before UI/rendering, including new form and render boundaries", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-redaction-settings-logging-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const sink = join(temporary, "synthetic-write-sink.log");
  const uiURL = new URL("../src/settings-ui.ts", import.meta.url).href;
  const configURL = new URL("../src/config.ts", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createSettingsUI } from ${JSON.stringify(uiURL)};
    import { offConfig } from ${JSON.stringify(configURL)};
    import { KeybindingsManager, TUI_KEYBINDINGS } from '@earendil-works/pi-tui';
    const secret = ${JSON.stringify(secret)};
    const notices = []; let calls = 0, listeners = 0;
    const ctx = { ui: {
      notify(message) { notices.push(message); },
      onTerminalInput() { listeners++; return () => { listeners--; }; },
      custom() { calls++; throw Error('private rendering must not start'); }
    } };
    const ui = createSettingsUI(); const signal = new AbortController().signal;
    if (process.env.CASE === 'initial') {
      assert.deepEqual(await ui.menu(ctx, offConfig(), offConfig(), 'inactive', signal), {kind:'cancel'});
      assert.equal(await ui.form(ctx, [secret, 'PRIVATE_ACCOUNT'], signal), undefined);
      assert.equal(calls, 0); assert.equal(listeners, 0);
      assert.equal(notices.length, 2); assert.match(notices[0], /terminal logging disabled/);
    } else {
      const tui = { terminal: {rows:24,columns:100}, requestRender() {} };
      const theme = { bold: text => text, fg: (_token, text) => text };
      const kb = new KeybindingsManager(TUI_KEYBINDINGS);
      let active;
      ctx.ui.custom = factory => new Promise(resolve => {
        active = factory(tui, theme, kb, value => { active.dispose(); resolve(value); });
      });
      if (process.env.CASE === 'boundary') {
        const menu = ui.menu(ctx, offConfig(), offConfig(), 'inactive', signal);
        active.handleInput('\\x1b'); await menu;
        process.env.PI_TUI_DEBUG = '1';
        assert.equal(await ui.form(ctx, [secret, 'PRIVATE_ACCOUNT'], signal), undefined);
        assert.match(notices[0], /terminal logging disabled/);
      } else if (process.env.CASE === 'factory') {
        ctx.ui.custom = factory => {
          process.env.PI_TUI_DEBUG = '1';
          return Promise.resolve(factory(tui, theme, kb, () => {}));
        };
        await assert.rejects(ui.form(ctx, [secret, 'PRIVATE_ACCOUNT'], signal), /terminal logging disabled/);
      } else {
        const form = ui.form(ctx, [secret, 'PRIVATE_ACCOUNT'], signal);
        assert.ok(active.render(100).join().includes(secret));
        process.env.PI_TUI_DEBUG = '1';
        if (process.env.CASE === 'input') active.handleInput('\\x13');
        else assert.deepEqual(active.render(100), []);
        assert.equal(await form, undefined);
      }
      assert.equal(listeners, 0);
    }
    assert.ok(!notices.join().includes(secret));
    console.log('synthetic logging guards passed');
  `;
  for (const [mode, debug, write] of [["initial", "1", ""], ["initial", "0", sink], ["boundary", "0", ""], ["factory", "0", ""], ["render", "0", ""], ["input", "0", ""]]) {
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      env: { ...process.env, CASE: mode, PI_TUI_DEBUG: debug, PI_TUI_WRITE_LOG: write }, encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /synthetic logging guards passed/);
  }
  await assert.rejects(access(sink), { code: "ENOENT" }, "no terminal write sink created");
});
