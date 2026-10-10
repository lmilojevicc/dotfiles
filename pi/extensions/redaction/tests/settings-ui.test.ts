import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, KeybindingsManager as HostKeys, Theme } from "@earendil-works/pi-coding-agent";
import { offConfig } from "../src/config.ts";
import { cloneDraft } from "../src/settings-model.ts";
import { createSettingsUI, decodeExact, encodeExact, formComponent, menuComponent, sectionItems } from "../src/settings-ui.ts";
import type { MenuOutcome } from "../src/settings-ui.ts";

const theme = { fg: (_token: string, text: string) => `\x1b[36m${text}\x1b[0m` } as unknown as Theme;
function toolkit(bindings = {}) {
  const kb = new KeybindingsManager(TUI_KEYBINDINGS, bindings);
  setKeybindings(kb);
  let renders = 0;
  const tui = { terminal: { rows: 24, columns: 80 }, requestRender() { renders++; } } as unknown as TUI;
  return { tui, kb: kb as HostKeys, renders: () => renders };
}
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const widths = [0, 1, 2, 3, 4, 7, 10, 20, 40, 80, 120];
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
test("settings-ui: compact status retains pending/unchanged at 40 columns and narrow headers identify the section", () => {
  const { tui, kb } = toolkit();
  const draft = offConfig();
  for (const section of ["sources", "detectors", "replacements"] as const) {
    const component = menuComponent(tui, theme, kb, () => {}, draft, offConfig(), "inactive", { section, index: 0 });
    assert.match(component.render(40)[1], /Draft: unchanged.*Saved: off/);
    draft.sources.toolResults = true;
    assert.match(component.render(40)[1], /Draft: pending.*Saved: off/);
    for (const width of [1, 4, 10, 20, 39]) {
      const lines = component.render(width); bounded(lines, width);
      assert.ok(lines[0].includes(section.slice(0, Math.min(width, section.length))));
      if (width >= 16) assert.match(lines[1], /Draft: pending/);
    }
    draft.sources.toolResults = false;
  }
});
test("settings-ui: native selection renders synchronized changes and navigation under rebinding", () => {
  const { tui, kb, renders } = toolkit({ "tui.select.up": ["k"], "tui.select.down": ["j", "space"], "tui.select.confirm": ["l"], "tui.select.cancel": ["q"] });
  const draft = offConfig(); const navigation = { section: "sources" as const, index: 0 };
  let outcome: MenuOutcome | undefined;
  const component = menuComponent(tui, theme, kb, value => { outcome = value; }, draft, offConfig(), "inactive", navigation);
  component.handleInput!("l"); assert.equal(draft.sources.toolResults, true);
  component.handleInput!(" "); assert.equal(draft.sources.userMessages, false, "space navigates when rebound");
  component.handleInput!("l"); assert.equal(draft.sources.userMessages, true);
  component.handleInput!("k"); component.handleInput!("\t");
  component.handleInput!("l"); assert.equal(draft.detectors.email, true);
  component.handleInput!("\x1b[Z");
  assert.match(component.render(120).join(), /\[sources\]/);
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
    const last = form.render(120).slice(-2).join(); assert.match(last, /valid JSON string/); assert.ok(!last.includes("synthetic-value"));
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
