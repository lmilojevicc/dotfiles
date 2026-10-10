import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Key, SettingsList, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component, SettingItem, SettingsListTheme, TUI } from "@earendil-works/pi-tui";
import type { ExtensionConfig } from "./contracts.ts";
import { isActive } from "./config.ts";
import type { MenuSection } from "./menu-contracts.ts";
import { detectorLabels, draftState, needsEscaped, safeAlias, sameConfig, sections, sourceLabels } from "./settings-model.ts";

export type MenuOutcome = { kind: "cancel" | "save" | "add" } | { kind: "edit" | "delete"; index: number };
export interface SettingsUI {
  menu(ctx: ExtensionCommandContext, draft: ExtensionConfig, saved: ExtensionConfig, running: string, signal: AbortSignal): Promise<MenuOutcome>;
  form(ctx: ExtensionCommandContext, entry: [string, string] | undefined, signal: AbortSignal): Promise<[string, string] | undefined>;
  confirm(ctx: ExtensionCommandContext, message: string, signal: AbortSignal): Promise<boolean>;
}
const cancelled: MenuOutcome = { kind: "cancel" };
function listTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => theme.fg(selected ? "accent" : "text", text),
    value: (text) => theme.fg("muted", text), description: text => theme.fg("muted", text),
    cursor: theme.fg("accent", "› "), hint: () => "",
  };
}
function fit(lines: string[], width: number): string[] {
  return width <= 0 ? [] : lines.map(line => truncateToWidth(line, width, ""));
}
function keyLabel(kb: KeybindingsManager, action: "up" | "down" | "confirm" | "cancel"): string {
  return safeAlias(kb.getKeys(`tui.select.${action}`)[0] ?? "unbound");
}
function terminalLoggingEnabled(): boolean {
  return process.env.PI_TUI_DEBUG === "1" || Boolean(process.env.PI_TUI_WRITE_LOG);
}
const loggingRefusal = "Redaction settings require Pi terminal logging disabled. Restart Pi without PI_TUI_DEBUG=1 or PI_TUI_WRITE_LOG.";
const guardRefusal = "Redaction settings require Pi's terminal-input guard. Update Pi before opening private forms.";
/** Guard before host-global diagnostics; custom UI has no signal option, so close its owned interaction on abort. */
async function localCustom<T>(ctx: ExtensionCommandContext, signal: AbortSignal, cancel: T,
  factory: (tui: TUI, theme: Theme, kb: KeybindingsManager, done: (value: T) => void) => Component & { dispose?(): void }): Promise<T> {
  if (signal.aborted) return cancel;
  if (terminalLoggingEnabled()) { ctx.ui.notify(loggingRefusal, "warning"); return cancel; }
  if (typeof ctx.ui.onTerminalInput !== "function") { ctx.ui.notify(guardRefusal, "warning"); return cancel; }
  let unsubscribe: (() => void) | undefined;
  let close: (() => void) | undefined;
  const release = () => { const owned = unsubscribe; unsubscribe = undefined; if (typeof owned === "function") owned(); };
  const abort = () => { close?.(); release(); };
  try {
    try {
      unsubscribe = ctx.ui.onTerminalInput(data => {
        if (terminalLoggingEnabled()) { close?.(); return { consume: true }; }
        // Same public matcher as Pi's global diagnostic shortcut, including protocol encodings.
        if (matchesKey(data, "shift+ctrl+d")) return { consume: true };
        return undefined;
      });
    } catch { ctx.ui.notify(guardRefusal, "warning"); return cancel; }
    if (typeof unsubscribe !== "function") { ctx.ui.notify(guardRefusal, "warning"); return cancel; }
    signal.addEventListener("abort", abort, { once: true });
    return await ctx.ui.custom<T>((tui, theme, kb, done) => {
      // Recheck after host setup, before constructing a form containing originals.
      if (signal.aborted) throw new Error("Redaction settings canceled.");
      if (terminalLoggingEnabled()) throw new Error(loggingRefusal);
      let finished = false;
      const finish = (value: T) => {
        if (finished) return;
        finished = true;
        done(value);
      };
      close = () => finish(cancel);
      const component = factory(tui, theme, kb, finish);
      return {
        render(width) {
          if (signal.aborted || finished) return [];
          if (terminalLoggingEnabled()) { finish(cancel); return []; }
          return component.render(width);
        },
        invalidate: () => component.invalidate(),
        handleInput(data) {
          if (signal.aborted || finished) return;
          if (terminalLoggingEnabled()) { finish(cancel); return; }
          component.handleInput?.(data);
        },
        get focused() { return (component as Component & { focused?: boolean }).focused ?? false; },
        set focused(value: boolean) { (component as Component & { focused?: boolean }).focused = value; },
        dispose() { finished = true; signal.removeEventListener("abort", abort); release(); component.dispose?.(); },
      };
    });
  } finally { signal.removeEventListener("abort", abort); release(); }
}
export function sectionItems(section: MenuSection, draft: ExtensionConfig): SettingItem[] {
  const items: SettingItem[] = section === "replacements" ? Object.entries(draft.literals).flatMap(([, alias], index) => [
    { id: `edit:${index}`, label: `#${index + 1} [masked]`, currentValue: safeAlias(alias), values: [safeAlias(alias)], description: "Edit exact value and alias locally." },
    { id: `delete:${index}`, label: `Delete #${index + 1}`, currentValue: "Delete…", values: ["Delete…"] },
  ]) : Object.entries(section === "sources" ? sourceLabels : detectorLabels).map(([key, label]) => ({
    id: key, label, currentValue: (draft[section] as Record<string, boolean>)[key] ? "on" : "off", values: ["off", "on"],
  }));
  if (section === "replacements") items.push({ id: "add", label: "Add replacement", currentValue: "Add…", values: ["Add…"] });
  items.push({ id: "save", label: "Save & reload", currentValue: "Save…", values: ["Save…"] });
  return items;
}
export function menuComponent(tui: TUI, theme: Theme, kb: KeybindingsManager, done: (value: MenuOutcome) => void,
  draft: ExtensionConfig, saved: ExtensionConfig, running: string, navigation: { section: MenuSection; index: number }): Component {
  let items: SettingItem[];
  let list: SettingsList;
  let visible = 8;
  const change = (id: string, value: string) => {
    if (id === "save" || id === "add") { done({ kind: id }); return; }
    if (id.startsWith("edit:") || id.startsWith("delete:")) {
      const [kind, index] = id.split(":");
      done({ kind: kind as "edit" | "delete", index: Number(index) }); return;
    }
    if (navigation.section !== "replacements") {
      const section = draft[navigation.section];
      if (Object.hasOwn(section, id)) (section as Record<string, boolean>)[id] = value === "on";
    }
    rebuild();
  };
  function rebuild() {
    items = sectionItems(navigation.section, draft);
    navigation.index = Math.min(navigation.index, items.length - 1);
    list = new SettingsList(items, visible, listTheme(theme), change, () => done(cancelled));
    list.selectItem(items[navigation.index].id);
  }
  rebuild();
  return {
    render(width) {
      if (width <= 0) return [];
      const rows = tui.terminal.rows;
      const nextVisible = Math.max(1, Math.min(8, rows - 8));
      if (nextVisible !== visible) { visible = nextVisible; rebuild(); }
      const body = list.render(Math.max(5, width));
      while (body.length && visibleWidth(body.at(-1)!) === 0) body.pop();
      return fit([
        theme.fg("accent", width < 40 ? navigation.section : sections.map(section => section === navigation.section ? `[${section}]` : section).join("  ")),
        theme.fg("muted", `Draft: ${sameConfig(saved, draft) ? "unchanged" : "pending"} · Saved: ${isActive(saved) ? "configured" : "off"}`),
        theme.fg("muted", `Running (at open): ${running}`),
        theme.fg("muted", `Draft filtering: ${draftState(draft)}`),
        ...body,
        theme.fg("muted", `${keyLabel(kb, "up")}/${keyLabel(kb, "down")} Move · ${keyLabel(kb, "confirm")}${["up", "down", "cancel"].some(action => kb.matches(" ", `tui.select.${action}` as "tui.select.up")) ? "" : "/Space"} Change · Tab/Shift-Tab Sections`),
        theme.fg("muted", `${keyLabel(kb, "cancel")} Cancel · Ctrl+S Save & reload`),
      ], width);
    },
    invalidate() { list.invalidate(); },
    handleInput(data) {
      if (kb.matches(data, "tui.select.cancel")) done(cancelled);
      else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
        navigation.index = (navigation.index + (kb.matches(data, "tui.select.up") ? -1 : 1) + items.length) % items.length;
        list.selectItem(items[navigation.index].id);
      } else if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        navigation.section = sections[(sections.indexOf(navigation.section) + (matchesKey(data, Key.tab) ? 1 : 2)) % 3];
        navigation.index = 0; rebuild();
      } else if (kb.matches(data, "tui.select.confirm") || data === " ") {
        const item = items[navigation.index];
        change(item.id, item.values![(item.values!.indexOf(item.currentValue) + 1) % item.values!.length]);
      } else if (matchesKey(data, Key.ctrl("s"))) done({ kind: "save" });
      tui.requestRender();
    },
  };
}
/** Escape terminal-active formatting characters even though JSON permits some literally. */
export function encodeExact(value: string): string {
  return JSON.stringify(value).replace(/[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu,
    character => character.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}
export function decodeExact(text: string, escaped: boolean): string {
  const value: unknown = escaped ? JSON.parse(text) : text;
  if (typeof value !== "string" || (!escaped && needsEscaped(value))) throw new Error("Invalid local value");
  return value;
}
export function formComponent(tui: TUI, theme: Theme, kb: KeybindingsManager,
  done: (value: [string, string] | undefined) => void, entry?: [string, string]): Component & { focused: boolean } {
  const values = entry ? [...entry] : ["", ""];
  const escaped = values.map(needsEscaped);
  let field = 0;
  let message = "";
  let paste: string | undefined;
  let droppingPaste = false;
  const editor = new Editor(tui, {
    borderColor: text => theme.fg("border", text),
    selectList: { selectedPrefix: text => theme.fg("accent", text), selectedText: text => theme.fg("accent", text), description: text => theme.fg("muted", text), scrollInfo: text => theme.fg("muted", text), noMatch: text => theme.fg("muted", text) },
  });
  editor.disableSubmit = true;
  const loadField = () => editor.setText(escaped[field] ? encodeExact(values[field]) : values[field]);
  const capture = () => { values[field] = decodeExact(editor.getExpandedText(), escaped[field]); };
  loadField();
  const input = (data: string) => {
    if (kb.matches(data, "tui.select.cancel")) { done(undefined); return; }
    try {
      if (matchesKey(data, Key.ctrl("s"))) { capture(); done([values[0], values[1]]); return; }
      if (matchesKey(data, Key.f2)) {
        capture();
        if (escaped[field] && needsEscaped(values[field])) { message = "This value needs escaped mode."; return; }
        escaped[field] = !escaped[field]; loadField(); message = ""; return;
      }
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || (!escaped[field] && kb.matches(data, "tui.input.submit"))) {
        capture(); field = 1 - field; loadField(); message = ""; return;
      }
      const isPaste = data.startsWith("\x1b[200~");
      const text = isPaste ? data.slice(6, -6) : data;
      if (needsEscaped(text) && (isPaste || !data.startsWith("\x1b") && !/^[\x01-\x1a]$/.test(data)) || !escaped[field] && kb.matches(data, "tui.input.newLine")) {
        message = "Use escaped mode (F2) and encode multiline, tabs or controls."; return;
      }
      const before = editor.getExpandedText();
      if (isPaste) editor.insertTextAtCursor(text);
      else editor.handleInput(data);
      // Encoded terminal keys can decode to formatting characters inside native Editor.
      // Keep its display buffer terminal-safe and refuse any implicit normalization mode.
      if (needsEscaped(editor.getExpandedText())) {
        editor.setText(before);
        message = "Use escaped mode (F2) and encode multiline, tabs or controls.";
      } else message = "";
    } catch { message = "Use a valid JSON string in escaped mode."; }
  };
  return {
    get focused() { return editor.focused; }, set focused(value) { editor.focused = value; },
    render(width) {
      if (width <= 0) return [];
      return fit([
        theme.fg("accent", `Local replacement: ${field === 0 ? "Original" : "Alias"} (${escaped[field] ? "escaped JSON string" : "plain text"})`),
        ...editor.render(Math.max(8, width)),
        theme.fg("warning", message),
        theme.fg("muted", `Tab Other field · F2 Plain/escaped · Ctrl+S Apply to draft · ${keyLabel(kb, "cancel")} Back`),
      ], width);
    },
    invalidate() { editor.invalidate(); },
    handleInput(data) {
      if (kb.matches(data, "tui.select.cancel")) { input(data); return; }
      if (droppingPaste) { if (data.includes("\x1b[201~")) droppingPaste = false; return; }
      // Assemble bracketed paste before native normalization; it may arrive in multiple terminal chunks.
      if (paste !== undefined || data.startsWith("\x1b[200~")) {
        paste = (paste ?? "") + data;
        if (paste.length > 1024 * 1024) { droppingPaste = !paste.includes("\x1b[201~"); paste = undefined; message = "Local input is too large."; tui.requestRender(); return; }
        if (!paste.endsWith("\x1b[201~")) return;
        const complete = paste; paste = undefined;
        input(complete);
      } else input(data);
      tui.requestRender();
    },
  };
}
export function createSettingsUI(): SettingsUI {
  const navigation = { section: "sources" as MenuSection, index: 0 };
  return {
    menu: (ctx, draft, saved, running, signal) => localCustom(ctx, signal, cancelled,
      (tui, theme, kb, done) => menuComponent(tui, theme, kb, done, draft, saved, running, navigation)),
    form: (ctx, entry, signal) => localCustom(ctx, signal, undefined as [string, string] | undefined,
      (tui, theme, kb, done) => formComponent(tui, theme, kb, done, entry)),
    confirm: (ctx, message, signal) => ctx.ui.confirm("Redaction", message, { signal }),
  };
}
