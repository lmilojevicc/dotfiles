import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { collectContextBreakdown, normalizeCategoryItems, showCategoryMenu, showTextPreview } from "../index.ts";

const theme = {
 fg: (color: string, text: string) => `\x1b[38;5;${({ accent: 201, border: 202, muted: 203, warning: 205, dim: 208, text: 209 } as Record<string, number>)[color] ?? 207}m${text}\x1b[39m`,
 bg: (color: string, text: string) => `\x1b[48;5;${color === "selectedBg" ? 211 : 212}m${text}\x1b[49m`,
 bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

test("category submenu uses root-style semantic ANSI at narrow width, clips labels and pages entries", async () => {
 let component: any;
 const items = Array.from({ length: 30 }, (_, i) => ({ label: `${i}: ` + "long label ".repeat(10), tokens: 4, content: `item ${i}`, source: "Session entry" }));
 const run = showCategoryMenu({ ui: { custom: (factory: any, options: any) => {
  assert.deepEqual(options.overlayOptions, { anchor: "center", width: 64, minWidth: 44, maxHeight: "90%", margin: 1 });
  return new Promise((resolve) => {
   component = factory({ mode: "inline", terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, null, resolve);
  });
 } } } as any, { label: "Context", tokens: 120, color: "warning" }, items, 1000);
 const initial = component.render(44);
 assert.ok(initial.every((line: string) => visibleWidth(line) === 44));
 assert.match(initial[1], /\x1b\[1m\x1b\[38;5;201mContext/);
 assert.match(initial[3], /\x1b\[38;5;205m█/);
 assert.match(initial[5], /\x1b\[48;5;211m/);
 assert.match(initial.at(-2), /\x1b\[38;5;208m/);
 assert.match(initial[5], /…/);
 assert.match(initial[5], /0\.4%\s+3%/, "numeric columns remain visible after label truncation");
 // At 24 rows the first page has 13 items; G and gg reposition both view and selection.
 component.handleInput("G");
 assert.match(component.render(44).join("\n"), /18-30\/30/);
 component.handleInput("g"); component.handleInput("g");
 assert.match(component.render(44).join("\n"), /1-13\/30/);
 component.handleInput("\x04"); // Ctrl-d pages down.
 assert.match(component.render(44).join("\n"), /2-14\/30/);
 component.handleInput("\x15"); // Ctrl-u pages up.
 assert.match(component.render(44).join("\n"), /1-13\/30/);
 component.handleMouse({ type: "move", screenX: 20, screenY: 7 }); // second item row 8
 assert.match(component.render(44).join("\n"), /\x1b\[48;5;212m/);
 component.handleInput("\x1b[B");
 component.handleInput("\r");
 assert.equal((await run)?.content, "item 1");
});

test("submenu labels and leaf titles escape terminal controls without mutating source labels", async () => {
 const label = "\x1b[2J\x1b]0;x\x07\r\t\nZ";
 const source = "S\x1b]2;x\x07";
 const categoryLabel = "Context\x1b[2J";
 const item = { label, source, tokens: 4, content: "# original", raw: true };
 let menu: any;
 const selection = showCategoryMenu({ ui: { custom: (factory: any) => new Promise((resolve) => {
  menu = factory({ mode: "inline", terminal: { rows: 24, columns: 120 }, requestRender() {} }, theme, null, resolve);
 }) } } as any, { label: categoryLabel, tokens: 4, color: "warning" }, [item], 1000);
 const stripTrustedSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
 const menuText = stripTrustedSgr(menu.render(64).join("\n"));
 assert.match(menuText, /Context\\x1b\[2J/);
 assert.match(menuText, /\\x1b\]0/);
 assert.doesNotMatch(menuText, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
 menu.handleInput("\r");
 const chosen = await selection;
 assert.equal(chosen?.label, label);
 assert.equal(chosen?.source, source);
 let leaf: any;
 const preview = showTextPreview({ ui: { custom: (factory: any) => new Promise((resolve) => {
  leaf = factory({ mode: "inline", terminal: { rows: 24, columns: 120 }, requestRender() {} }, theme, null, resolve);
 }) } } as any, `${chosen!.source} · ${chosen!.label}`, chosen!.content, chosen!.raw);
 const leafText = stripTrustedSgr(leaf.render(96).join("\n"));
 assert.match(leafText, /controls escaped/);
 assert.match(leafText, /S\\x1b\]2;x\\x07/);
 assert.match(leafText, /\\x1b\[2J\\x1b\]0;x\\x07\\r\\t\\nZ/);
 assert.match(leafText, /# original/);
 assert.doesNotMatch(leafText, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
 leaf.handleInput("\x1b");
 await preview;
});

test("submenu reconciles 100 raw result tokens to a 50-token parent", async () => {
 const items = [
  { label: "first", tokens: 79, content: "first raw content", source: "Session entry" },
  { label: "second", tokens: 21, content: "second raw content", source: "Session entry" },
  { label: "unloaded", tokens: 0, content: "local source", source: "NOT LOADED" },
 ];
 const adjusted = normalizeCategoryItems(items, 50);
 assert.deepEqual(adjusted.map((item) => item.tokens), [40, 10, 0]);
 assert.equal(adjusted.reduce((sum, item) => sum + item.tokens, 0), 50);
 assert.deepEqual(items.map((item) => item.tokens), [79, 21, 0], "raw estimates remain intact");
 let component: any;
 const run = showCategoryMenu({ ui: { custom: (factory: any) => new Promise((resolve) => {
  component = factory({ mode: "inline", terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, null, resolve);
 }) } } as any, { label: "Tool results", tokens: 50, color: "warning" }, items, 1000);
 const rendered = component.render(64).join("\n");
 assert.match(rendered, /50 tokens \(5\.0%\)/);
 assert.match(rendered, /40\s+4\.0%\s+80%/);
 assert.match(rendered, /10\s+1\.0%\s+20%/);
 assert.doesNotMatch(rendered, /\d{3}%/);
 component.handleInput("\r");
 assert.equal((await run)?.content, "first raw content");
});

test("submenu items identify local schema, advertised skills, unloaded disk source, and session entries", () => {
 const directory = mkdtempSync(join(tmpdir(), "context-submenu-"));
 try {
  const path = join(directory, "SKILL.md");
  writeFileSync(path, "# Local instructions only");
  const skill = { name: "helper", description: "A helper", filePath: path };
  const hidden = { name: "hidden", description: "Not advertised", filePath: path, disableModelInvocation: true };
  const advertisement = formatSkillsForPrompt([skill]).trim();
  const breakdown = collectContextBreakdown({
   getSystemPrompt: () => `Base instructions\nMEMORY_SAMPLE\n${advertisement}`,
   getSystemPromptOptions: () => ({ selectedTools: ["lookup"], skills: [skill, hidden], contextFiles: [{ path: "AGENTS.md", content: "MEMORY_SAMPLE" }] }),
   sessionManager: { buildContextEntries: () => [
    { type: "message", message: { role: "user", content: "question" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
    { type: "message", message: { role: "toolResult", toolName: "lookup", content: "result", toolCallId: "1" } },
   ] },
  } as any, [{ name: "lookup", description: "Find", parameters: { type: "object" } }] as any);
  assert.equal(breakdown.items.memoryFiles[0].content, "MEMORY_SAMPLE");
  assert.equal(breakdown.items.memoryFiles[0].raw, true);
  assert.equal(breakdown.items.systemPrompt[0].raw, true);
  assert.match(breakdown.items.skills[0].content, /<name>helper<\/name>/);
  assert.match(breakdown.items.skills[0].source, /Prompt advertisement/);
  assert.equal(breakdown.items.skills[1].tokens, 0);
  assert.match(breakdown.items.skills[1].source, /NOT LOADED/);
  assert.match(breakdown.items.skills[1].content, /Local instructions only/);
  assert.match(breakdown.items.skills[2].label, /unattributed/);
  assert.equal(breakdown.items.skills.length, 3, "non-advertised skills are not attributed; wrapper is separate");
  assert.match(breakdown.items.tools[0].content, /"parameters"/);
  assert.match(breakdown.items.tools[0].source, /Local registered tool schema/);
  assert.equal(breakdown.items.toolResults[0].content, "result");
  assert.equal(breakdown.items.toolResults[0].raw, true);
  assert.equal(breakdown.items.contextFiles[0].content, "question");
  assert.equal(breakdown.items.contextFiles[1].content, "hello");
  assert.ok(breakdown.items.contextFiles.every((item) => item.raw));
  assert.match(breakdown.items.contextFiles[0].source, /provider payload unavailable/);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("multiple advertised skills each remain individually selectable", () => {
 const skills = [
  { name: "alpha", description: "First", filePath: "/missing/alpha/SKILL.md" },
  { name: "beta", description: "Second", filePath: "/missing/beta/SKILL.md" },
 ];
 const prompt = formatSkillsForPrompt(skills).trim();
 const breakdown = collectContextBreakdown({
  getSystemPrompt: () => prompt,
  getSystemPromptOptions: () => ({ selectedTools: [], skills, contextFiles: [] }),
  sessionManager: { buildContextEntries: () => [] },
 } as any, []);
 assert.deepEqual(breakdown.items.skills.map((item) => item.label), ["alpha", "beta", "Skill prompt wrapper · unattributed"]);
 assert.ok(breakdown.items.skills[0].tokens > 0 && breakdown.items.skills[1].tokens > 0);
 assert.equal(breakdown.items.skills.reduce((sum, item) => sum + item.tokens, 0), breakdown.parts[2].tokens);
});
