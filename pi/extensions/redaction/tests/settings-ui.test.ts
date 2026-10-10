import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, KeybindingsManager as HostKeys, Theme } from "@earendil-works/pi-coding-agent";
import { offConfig } from "../src/config.ts";
import { cloneDraft } from "../src/settings-model.ts";
import { createSettingsUI, decodeExact, encodeExact, formComponent, menuComponent, sectionItems } from "../src/settings-ui.ts";
import type { MenuOutcome } from "../src/settings-ui.ts";

const colors = { accent: 36, text: 37, dim: 90, muted: 90, success: 32, warning: 33, border: 34, borderMuted: 30 };
const theme = { bold: (text: string) => `\x1b[1m${text}\x1b[22m`, fg: (token: keyof typeof colors, text: string) => `\x1b[${colors[token]}m${text}\x1b[0m` } as unknown as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
function toolkit(bindings = {}) {
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(kb);
  let renders = 0;
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() { renders++; } } as unknown as TUI;
  return { tui, kb: kb as HostKeys, renders: () => renders };
}
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const widths = [0, 1, 2, 3, 4, 7, 10, 20, 40, 60, 80, 120];
const bounded = (lines: string[], width: number) => { for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`); };

test("settings-ui: real SettingsList renders all sections at zero/narrow/Unicode widths and resize", () => {
  const { tui, kb } = toolkit();
  const draft = offConfig(); draft.literals = { "never-display-synthetic-original": "名🙂é\x1b]52;c;fake\x07\u202e" };
  const saved = cloneDraft(draft);
  for (const section of ["sources", "detectors", "replacements"] as const) {
    const component = menuComponent(tui, theme, kb, () => {}, draft, saved, "inactive", { section, index: 0 });
    for (const rows of [5, 24, 60]) {
      (tui.terminal as unknown as { rows: number }).rows = rows;
      for (const width of widths) {
        const lines = component.render(width); bounded(lines, width);
        assert.ok(!lines.join().includes("never-display-synthetic-original"));
        assert.ok(!lines.join().includes("\x1b]52")); assert.ok(!lines.join().includes("\u202e"));
        if (!width) assert.deepEqual(lines, []);
      }
      component.invalidate();
    }
  }
  const items = sectionItems("replacements", draft);
  assert.deepEqual(items.map(i => i.id), ["edit:0", "delete:0", "add", "save"]);
  assert.ok(!JSON.stringify(items).includes("never-display-synthetic-original"));
});
test("settings-ui: createSettingsUI opens Redact and exposes five independent all-off switches", async () => {
  const { tui, kb } = toolkit();
  const draft = offConfig(); const saved = offConfig();
  let component: any;
  const ctx = { ui: { onTerminalInput: () => () => {}, custom(factory: any) {
    return new Promise(resolve => { component = factory(tui, theme, kb, resolve); });
  } } } as unknown as ExtensionCommandContext;
  const pending = createSettingsUI().menu(ctx, draft, saved, "inactive", new AbortController().signal);
  const frame = component.render(40);
  assert.match(plain(frame), /Redact  \/  Sources  \/  Replacements/);
  assert.ok(frame[1].includes(theme.bold("Redact")));
  assert.ok(frame[1].includes(theme.fg("dim", "Sources")));
  assert.equal(frame[0], theme.fg("accent", "─".repeat(40)));
  assert.equal(frame[2], theme.fg("borderMuted", "─".repeat(40)));
  for (const label of ["Emails", "Phone numbers", "API keys", "Private keys", "Credential URLs", "Save & reload"]) {
    assert.ok(plain(frame).includes(label));
  }
  assert.match(plain(frame), /  › Emails +Off/);
  assert.ok(!plain(frame).includes("Save…"));
  const keys = ["email", "phone", "apiToken", "privateKey", "credentialUrl"] as const;
  for (const key of keys) {
    component.handleInput(" ");
    assert.deepEqual(draft.detectors, { ...offConfig().detectors, [key]: true });
    assert.deepEqual(draft.sources, offConfig().sources);
    assert.ok(component.render(40).join().includes(theme.fg("success", theme.bold("On"))));
    component.handleInput("\r");
    assert.deepEqual(draft.detectors, offConfig().detectors);
    component.handleInput("\x1b[B");
  }
  component.handleInput("\r"); assert.deepEqual(await pending, { kind: "save" });
  component.dispose(); assert.deepEqual(saved, offConfig());
});
test("settings-ui: concise state is runtime-safe, dirty-aware and warns only on incomplete drafts", () => {
  const { tui, kb } = toolkit();
  const draft = offConfig(); const saved = offConfig();
  const component = menuComponent(tui, theme, kb, () => {}, draft, saved, "inactive", { section: "detectors", index: 0 });
  assert.match(plain(component.render(40)), /Running: inactive · Saved: off/);
  assert.ok(!plain(component.render(40)).includes("Choose"));
  draft.detectors.email = true;
  assert.match(plain(component.render(40)), /Unsaved · Running: inactive/);
  assert.match(plain(component.render(40)), /Choose a source in Sources/);
  assert.ok(!plain(component.render(40)).includes("filtering configured"));
  draft.sources.toolResults = true;
  assert.ok(!plain(component.render(40)).includes("Choose"));
  draft.detectors.email = false;
  assert.match(plain(component.render(40)), /Choose what to redact/);
  saved.detectors.email = true; saved.sources.toolResults = true;
  assert.match(plain(component.render(80)), /Running: inactive · Saved: configured/);
  const failed = menuComponent(tui, theme, kb, () => {}, draft, saved, "unavailable (protected transmission censored)", { section: "detectors", index: 0 });
  assert.match(plain(failed.render(40)).replace(/\n +/g, " "), /Running: unavailable \(protected transmission censored\)/);
  for (const section of ["detectors", "sources", "replacements"] as const) {
    const ui = menuComponent(tui, theme, kb, () => {}, draft, saved, "active", { section, index: 0 });
    for (const width of [1, 2, 10, 20, 40, 60, 80, 120]) {
      const lines = ui.render(width); bounded(lines, width);
      const label = { detectors: "Redact", sources: "Sources", replacements: "Replacements" }[section];
      if (width >= 10 && width < 37) assert.ok(plain([lines[1]]).trim().startsWith(label.slice(0, width - 2)));
      if (width >= 40) { assert.match(plain(lines), /Ctrl\+S Save & reload/); assert.match(plain(lines), /escape Cancel/); }
    }
  }
});
test("settings-ui: ordered tabs wrap both directions and replacement scrolling keeps the selected action", () => {
  const { tui, kb } = toolkit();
  const draft = offConfig();
  draft.literals = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`synthetic-original-${i}`, `PRIVATE_${i}`]));
  const navigation = { section: "detectors" as "detectors" | "sources" | "replacements", index: 0 };
  const ui = menuComponent(tui, theme, kb, () => {}, draft, offConfig(), "inactive", navigation);
  for (const section of ["sources", "replacements", "detectors"]) { ui.handleInput!("\t"); assert.equal(navigation.section, section); }
  ui.handleInput!("\x1b[Z"); assert.equal(navigation.section, "replacements");
  ui.handleInput!("\x1b[A"); assert.equal(navigation.index, 61);
  for (const rows of [12, 20, 24, 60]) {
    (tui.terminal as unknown as { rows: number }).rows = rows;
    for (const width of [40, 60, 80, 120]) {
      const lines = ui.render(width); bounded(lines, width);
      assert.match(plain(lines), /› Save & reload/);
      assert.ok(lines.length <= rows, `${lines.length} > ${rows}`);
      assert.ok(!plain(lines).includes("synthetic-original"));
    }
  }
  ui.handleInput!("\x1b[B"); assert.equal(navigation.index, 0);
  assert.match(plain(ui.render(40)), /› #1 \[masked\]/);
});
test("settings-ui: native selection renders synchronized changes and navigation under rebinding", () => {
  const { tui, kb, renders } = toolkit({ "tui.select.up": ["k"], "tui.select.down": ["j", "space"], "tui.select.confirm": ["l"], "tui.select.cancel": ["q"] });
  const draft = offConfig(); const navigation = { section: "sources" as const, index: 0 };
  let outcome: MenuOutcome | undefined;
  const component = menuComponent(tui, theme, kb, value => { outcome = value; }, draft, offConfig(), "inactive", navigation);
  component.handleInput!("l"); assert.equal(draft.sources.toolResults, true);
  component.handleInput!(" "); assert.equal(draft.sources.userMessages, false, "space navigates when rebound");
  component.handleInput!("l"); assert.equal(draft.sources.userMessages, true);
  component.handleInput!("k"); component.handleInput!("\x1b[Z");
  component.handleInput!("l"); assert.equal(draft.detectors.email, true);
  component.handleInput!("\t");
  assert.match(component.render(120)[1], /\x1b\[1mSources\x1b\[22m/);
  assert.match(component.render(120).join(), /j.*Move/);
  assert.ok(!component.render(120).join().includes("/Space Change"));
  component.handleInput!("q"); assert.deepEqual(outcome, { kind: "cancel" }); assert.ok(renders() > 0);
});
test("settings-ui: replacement action rows, Save row and Ctrl+S are accessible without secret IDs", () => {
  const { tui, kb } = toolkit();
  const draft = offConfig(); draft.literals = { "synthetic-original": "PRIVATE_ONE" };
  const outcomes: MenuOutcome[] = [];
  const component = menuComponent(tui, theme, kb, value => outcomes.push(value), draft, offConfig(), "inactive", { section: "replacements", index: 0 });
  component.handleInput!("\r");
  component.handleInput!("\x1b[B"); component.handleInput!(" ");
  component.handleInput!("\x1b[B"); component.handleInput!("\r");
  component.handleInput!("\x1b[B"); component.handleInput!("\r");
  component.handleInput!("\x13");
  assert.deepEqual(outcomes, [{ kind: "edit", index: 0 }, { kind: "delete", index: 0 }, { kind: "add" }, { kind: "save" }, { kind: "save" }]);
});
test("settings-ui: native Editor plain form preserves spaces, Unicode, literal quotes/backslashes", () => {
  const { tui, kb } = toolkit();
  let result: [string, string] | undefined;
  const component = formComponent(tui, theme, kb, value => { result = value; });
  component.focused = true;
  const value = '  name名🙂 "quoted" \\literal  ';
  component.handleInput!(paste(value)); component.handleInput!("\t");
  component.handleInput!(paste("  PRIVATE_ALIAS  ")); component.handleInput!("\x13");
  assert.deepEqual(result, [value, "  PRIVATE_ALIAS  "]);
  for (const width of widths) bounded(component.render(width), width);
});
test("settings-ui: real Editor exact suffix paste bypasses dot/slash/tilde convenience for both fields", () => {
  const { tui, kb } = toolkit();
  for (const suffix of [".example", "/example", "~example"]) {
    let result: [string, string] | undefined;
    const component = formComponent(tui, theme, kb, value => { result = value; }, ["account", "PRIVATE_ACCOUNT"]);
    component.handleInput!("\x1b[200~" + suffix.slice(0, 2));
    component.handleInput!(suffix.slice(2) + "\x1b[201~");
    component.handleInput!("\t");
    component.handleInput!(paste(suffix));
    component.handleInput!("\x13");
    assert.deepEqual(result, ["account" + suffix, "PRIVATE_ACCOUNT" + suffix]);
  }
});
test("settings-ui: exact paste insertion retains cursor position and one-step undo", () => {
  const { tui, kb } = toolkit({ "tui.editor.undo": ["ctrl+z"] });
  for (const undo of [false, true]) {
    let result: [string, string] | undefined;
    const component = formComponent(tui, theme, kb, value => { result = value; }, ["accounttail", "PRIVATE_ACCOUNT"]);
    component.handleInput!("\x01");
    for (let index = 0; index < 7; index++) component.handleInput!("\x1b[C");
    component.handleInput!("\x1b[200~.exa"); component.handleInput!("mple\x1b[201~");
    if (undo) component.handleInput!("\x1a");
    else component.handleInput!("X");
    component.handleInput!("\x13");
    assert.deepEqual(result, [undo ? "accounttail" : "account.exampleXtail", "PRIVATE_ACCOUNT"]);
  }
});
test("settings-ui: escaped form round-trips CRLF/tabs/multiline/bidi/control text and exact alias", () => {
  const { tui, kb } = toolkit();
  const raw = " \r\nline\ttwo\n\x1b]52;c;fake\x07\u202e ";
  const alias = " PRIVATE\tALIAS\n ";
  let result: [string, string] | undefined;
  const component = formComponent(tui, theme, kb, value => { result = value; }, [raw, alias]);
  assert.match(component.render(120).join(), /escaped JSON string/);
  assert.ok(!component.render(120).join().includes("\x1b]52")); assert.ok(!component.render(120).join().includes("\u202e"));
  component.handleInput!("\x1bOQ"); // F2 cannot switch unsafe values to plain.
  assert.match(component.render(120).join(), /needs escaped/);
  component.handleInput!("\t"); component.handleInput!("\x13");
  assert.deepEqual(result, [raw, alias]);
  assert.equal(decodeExact(encodeExact(raw), true), raw);
  const astralControl = "x\u{e0001}\u{e0061}y";
  assert.equal(decodeExact(encodeExact(astralControl), true), astralControl);
  assert.ok(!encodeExact(astralControl).includes("\u{e0001}"));
});
test("settings-ui: split unsafe paste is refused before normalization/terminal interpretation", () => {
  const { tui, kb } = toolkit();
  let result: [string, string] | undefined;
  const component = formComponent(tui, theme, kb, value => { result = value; }, ["unchanged", "PRIVATE_ONE"]);
  component.handleInput!("\x1b[200~"); component.handleInput!(" raw\r\n\t\x1b]52;c;fake\x07"); component.handleInput!("\x1b[201~");
  assert.match(component.render(120).join(), /Use escaped mode/);
  assert.ok(!component.render(120).join().includes("\x1b]52"));
  component.handleInput!("\x13"); assert.deepEqual(result, ["unchanged", "PRIVATE_ONE"]);
});
test("settings-ui: plain-to-escaped switch and JSON string-only validation/cancel are value-free", () => {
  const { tui, kb } = toolkit();
  let result: [string, string] | undefined;
  const component = formComponent(tui, theme, kb, value => { result = value; }, ['  "quoted" \\  ', "PRIVATE"]);
  component.handleInput!("\x1bOQ"); assert.match(component.render(120).join(), /escaped JSON string/);
  component.handleInput!("\x13"); assert.deepEqual(result, ['  "quoted" \\  ', "PRIVATE"]);
  for (const invalid of ["{\"synthetic-value\":1}", "123", "null", "invalid-synthetic-value", '"unterminated']) {
    let done = false;
    const form = formComponent(tui, theme, kb, () => { done = true; }, ["simple", "PRIVATE"]);
    form.handleInput!("\x1bOQ"); form.handleInput!("\x01"); form.handleInput!("\x0b"); form.handleInput!(paste(invalid)); form.handleInput!("\x13");
    assert.equal(done, false);
    const last = form.render(120).slice(-3).join(); assert.match(last, /valid JSON string/); assert.ok(!last.includes("synthetic-value"));
    form.handleInput!("\x1b"); assert.equal(done, true);
  }
  for (const value of [1, {}, [], null]) assert.throws(() => decodeExact(JSON.stringify(value), true));
});
test("settings-ui: encoded formatting keys/newlines cannot inject controls or normalize plain values", () => {
  const { tui, kb } = toolkit();
  let result: [string, string] | undefined;
  const component = formComponent(tui, theme, kb, value => { result = value; }, ["  exact  ", "PRIVATE"]);
  for (const key of ["\x1b[8238u", "\x1b\r", "\x1b[13;2~", "\n"]) {
    component.handleInput!(key);
    assert.ok(!component.render(120).join().includes("\u202e"));
  }
  component.handleInput!("\x13"); assert.deepEqual(result, ["  exact  ", "PRIVATE"]);
});
test("settings-ui: excessive split paste is discarded without appending a misleading tail", () => {
  const { tui, kb } = toolkit();
  let result: [string, string] | undefined;
  const component = formComponent(tui, theme, kb, value => { result = value; }, ["unchanged", "PRIVATE"]);
  component.handleInput!("\x1b[200~" + "x".repeat(1024 * 1024));
  component.handleInput!("do-not-append-tail\x1b[201~");
  assert.match(component.render(120).join(), /too large/);
  component.handleInput!("\x13"); assert.deepEqual(result, ["unchanged", "PRIVATE"]);
});
test("settings-ui: local custom abort closes once; disposed components cannot activate later", async () => {
  const { tui, kb } = toolkit();
  const abort = new AbortController(); let component: any; let completions = 0;
  const ctx = { ui: { onTerminalInput: () => () => {}, custom(factory: any) {
    return new Promise(resolve => {
      component = factory(tui, theme, kb, (value: unknown) => { completions++; component.dispose(); resolve(value); });
    });
  } } } as unknown as ExtensionCommandContext;
  const pending = createSettingsUI().menu(ctx, offConfig(), offConfig(), "inactive", abort.signal);
  abort.abort(); assert.deepEqual(await pending, { kind: "cancel" });
  component.handleInput("\x13"); component.dispose(); assert.equal(completions, 1);
  assert.deepEqual(component.render(80), []);
});
