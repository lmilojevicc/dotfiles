import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Key, SettingsList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component, SettingItem, SettingsListTheme, TUI } from "@earendil-works/pi-tui";
import type { ExtensionConfig } from "./contracts.ts";
import { isActive } from "./config.ts";
import type { MenuSection } from "./menu-contracts.ts";
import { detectorLabels, draftState, needsEscaped, safeAlias, sameConfig, sectionLabels, sections, sourceLabels } from "./settings-model.ts";

export type MenuOutcome = { kind: "cancel" | "save" | "add" } | { kind: "edit" | "delete"; index: number };
export interface SettingsUI {
  menu(ctx: ExtensionCommandContext, draft: ExtensionConfig, saved: ExtensionConfig, running: string, signal: AbortSignal): Promise<MenuOutcome>;
  form(ctx: ExtensionCommandContext, entry: [string, string] | undefined, signal: AbortSignal): Promise<[string, string] | undefined>;
  confirm(ctx: ExtensionCommandContext, message: string, signal: AbortSignal): Promise<boolean>;
}
const cancelled: MenuOutcome = { kind: "cancel" };
function listTheme(theme: Theme): SettingsListTheme {
  return {
    label: (text, selected) => selected ? theme.bold(theme.fg("text", text)) : theme.fg("text", text),
    value: (text, selected) => text === "On" ? theme.fg("success", selected ? theme.bold(text) : text) : theme.fg("dim", text),
    description: text => theme.fg("muted", text),
    cursor: theme.fg("accent", "› "), hint: () => "",
  };
}
function fit(lines: string[], width: number): string[] {
  return width <= 0 ? [] : lines.map(line => truncateToWidth(line, width, ""));
}
function inset(lines: string[], width: number): string[] {
  const padding = " ".repeat(Math.min(2, Math.max(0, width - 1)));
  return fit(lines.map(line => padding + line), width);
}
function controls(hints: string[], width: number): string[] {
  const lines: string[] = [];
  for (const hint of hints) {
    const last = lines.at(-1);
    if (last && visibleWidth(`${last} · ${hint}`) <= width) lines[lines.length - 1] += ` · ${hint}`;
    else lines.push(...wrapTextWithAnsi(hint, Math.max(1, width)));
  }
  return lines;
}
function tabs(theme: Theme, section: MenuSection, width: number): string {
  const labels = sections.map(tab => tab === section ? theme.bold(sectionLabels[tab]) : theme.fg("dim", sectionLabels[tab]));
  const full = labels.join(theme.fg("dim", "  /  "));
  return visibleWidth(full) <= width ? full : theme.bold(sectionLabels[section]) + theme.fg("dim", ` (${sections.indexOf(section) + 1}/3)`);
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
    { id: `edit:${index}`, label: `#${index + 1} [masked]`, currentValue: safeAlias(alias), values: [safeAlias(alias)] },
    { id: `delete:${index}`, label: `Delete #${index + 1}`, currentValue: "", values: [""] },
  ]) : Object.entries(section === "sources" ? sourceLabels : detectorLabels).map(([key, label]) => ({
    id: key, label, currentValue: (draft[section] as Record<string, boolean>)[key] ? "On" : "Off", values: ["Off", "On"],
  }));
  if (section === "replacements") items.push({ id: "add", label: "Add replacement", currentValue: "", values: [""] });
  items.push({ id: "save", label: "Save & reload", currentValue: "", values: [""] });
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
      if (Object.hasOwn(section, id)) (section as Record<string, boolean>)[id] = value === "On";
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
      const innerWidth = Math.max(1, width - 2);
      const rows = tui.terminal.rows;
      const spacious = rows >= 20;
      const space = spacious ? [""] : [];
      const dirty = !sameConfig(saved, draft);
      // Running is an at-open snapshot, never inferred from the enabled draft switches.
      const status = wrapTextWithAnsi(`${dirty ? "Unsaved · " : ""}Running: ${safeAlias(running)} · Saved: ${isActive(saved) ? "configured" : "off"}`, innerWidth);
      const warning = draftState(draft);
      const spaceKey = ["up", "down", "cancel"].some(action => kb.matches(" ", `tui.select.${action}` as "tui.select.up")) ? "" : "/Space";
      const footer = controls([
        `Ctrl+S Save & reload`, `${keyLabel(kb, "cancel")} Cancel`,
        `${keyLabel(kb, "up")}/${keyLabel(kb, "down")} Move`,
        `${keyLabel(kb, "confirm")}${spaceKey} ${navigation.section === "replacements" || items[navigation.index].id === "save" ? "Select" : "Toggle"}`,
        "Tab/Shift+Tab Sections",
      ], innerWidth);
      const fixedRows = 4 + space.length * 3 + status.length + (warning ? wrapTextWithAnsi(warning, innerWidth).length : 0) + footer.length;
      const nextVisible = Math.max(1, Math.min(8, rows - fixedRows));
      if (nextVisible !== visible) { visible = nextVisible; rebuild(); }
      const body = list.render(Math.max(5, innerWidth));
      while (body.length && visibleWidth(body.at(-1)!) === 0) body.pop();
      return fit([
        theme.fg("accent", "─".repeat(width)),
        ...inset([tabs(theme, navigation.section, innerWidth)], width),
        theme.fg("borderMuted", "─".repeat(width)),
        ...space,
        ...inset(status.map(line => theme.fg("muted", line)), width),
        ...inset(warning ? wrapTextWithAnsi(warning, innerWidth).map(line => theme.fg("warning", line)) : [], width),
        ...space,
        ...inset(body, width),
        ...space,
        ...inset(footer.map(line => theme.fg("dim", line)), width),
        theme.fg("accent", "─".repeat(width)),
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
      const innerWidth = Math.max(1, width - 2);
      return fit([
        theme.fg("accent", "─".repeat(width)),
        ...inset(wrapTextWithAnsi(`Local replacement: ${field === 0 ? "Original" : "Alias"} (${escaped[field] ? "escaped JSON string" : "plain text"})`, innerWidth).map(line => theme.bold(line)), width),
        theme.fg("borderMuted", "─".repeat(width)),
        "",
        ...inset(editor.render(Math.max(8, innerWidth)), width),
        ...inset([theme.fg("warning", message)], width),
        ...inset(controls(["Ctrl+S Apply to draft", `${keyLabel(kb, "cancel")} Back`, "Tab Other field", "F2 Plain/escaped"], innerWidth).map(line => theme.fg("dim", line)), width),
        theme.fg("accent", "─".repeat(width)),
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
  const navigation = { section: "detectors" as MenuSection, index: 0 };
  return {
    menu: (ctx, draft, saved, running, signal) => localCustom(ctx, signal, cancelled,
      (tui, theme, kb, done) => menuComponent(tui, theme, kb, done, draft, saved, running, navigation)),
    form: (ctx, entry, signal) => localCustom(ctx, signal, undefined as [string, string] | undefined,
      (tui, theme, kb, done) => formComponent(tui, theme, kb, done, entry)),
    confirm: (ctx, message, signal) => ctx.ui.confirm("Redaction", message, { signal }),
  };
}
