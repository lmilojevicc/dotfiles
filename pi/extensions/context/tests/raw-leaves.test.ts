import assert from "node:assert/strict";
import test from "node:test";
import { collectContextBreakdown, showTextPreview } from "../index.ts";

const theme = {
 fg: (_color: string, text: string) => text,
 bg: (_color: string, text: string) => text,
 bold: (text: string) => text,
};

test("local memory, prompt, and session text leaves retain Markdown headings and whitespace", async () => {
 const text = "# Heading  \n  indented  \n\n" + "x".repeat(900) + "TAIL";
 const breakdown = collectContextBreakdown({
  getSystemPrompt: () => text,
  getSystemPromptOptions: () => ({ contextFiles: [{ path: "AGENTS.md", content: text }], skills: [], selectedTools: [] }),
  sessionManager: { buildContextEntries: () => [
   { type: "message", message: { role: "user", content: text } },
   { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } },
   { type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text }] } },
   { type: "custom_message", customType: "note", content: text },
  ] },
 } as any, []);
 const leaves = [
  ...breakdown.items.memoryFiles,
  ...breakdown.items.systemPrompt,
  ...breakdown.items.contextFiles.filter((item) => item.content === text),
  breakdown.items.toolResults[0],
 ];
 assert.equal(leaves.length, 6);
 for (const leaf of leaves) {
  assert.equal(leaf.raw, true, leaf.label);
  if (leaf === breakdown.items.toolResults[0]) {
   assert.equal(leaf.content, JSON.stringify([{ type: "text", text }], null, 2));
   assert.doesNotMatch(leaf.content, /```json/);
  } else assert.equal(leaf.content, text);
  let component: any;
  const preview = showTextPreview({ ui: { custom: (factory: any) => new Promise((resolve) => {
   component = factory({ mode: "inline", terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, null, resolve);
  }) } } as any, leaf.label, leaf.content, leaf.raw);
  const first = component.render(64).join("\n");
  if (leaf !== breakdown.items.toolResults[0]) {
   assert.match(first, /# Heading  /);
   assert.match(first, /  indented  /);
   assert.match(first, /lines/);
  }
  component.handleInput("G");
  assert.match(component.render(64).join("\n"), /TAIL/);
  component.handleInput("\x1b");
  await preview;
 }
});

test("raw leaves expose reversible tabs, CRLF, ESC and literal backslashes without terminal controls", async () => {
 const original = "# Heading\t  indented\r\n\\t literal\x1bEND";
 const breakdown = collectContextBreakdown({
  getSystemPrompt: () => original,
  getSystemPromptOptions: () => ({ contextFiles: [{ path: "AGENTS.md", content: original }], selectedTools: [] }),
  sessionManager: { buildContextEntries: () => [{ type: "message", message: { role: "user", content: original } }] },
 } as any, []);
 const leaves = [breakdown.items.memoryFiles[0], breakdown.items.systemPrompt[0], breakdown.items.contextFiles[0]];
 for (const leaf of leaves) {
  assert.equal(leaf.content, original);
  assert.equal(leaf.raw, true);
  let component: any;
  const preview = showTextPreview({ ui: { custom: (factory: any) => new Promise((resolve) => {
   component = factory({ mode: "inline", terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, null, resolve);
  }) } } as any, "Local text", leaf.content, leaf.raw);
  const rendered = component.render(64).join("\n");
  assert.match(rendered, /controls escaped/);
  assert.match(rendered, /# Heading\\t  indented\\r/);
  assert.match(rendered, /\\\\t literal\\x1bEND/);
  assert.doesNotMatch(rendered, /\t|\r|\x1b/);
  component.handleInput("\x1b");
  await preview;
 }
});

test("structured session leaves use plain local serialization, not Markdown or a provider-payload claim", () => {
 const breakdown = collectContextBreakdown({
  getSystemPrompt: () => "",
  getSystemPromptOptions: () => ({ selectedTools: [] }),
  sessionManager: { buildContextEntries: () => [
   { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "# file" } }] } },
   { type: "message", message: { role: "bashExecution", command: "echo hi", output: "# output" } },
  ] },
 } as any, []);
 assert.equal(breakdown.items.contextFiles[0].content, '{\n  "path": "# file"\n}');
 assert.equal(breakdown.items.contextFiles[0].raw, true);
 assert.equal(breakdown.items.toolResults[0].content, "# output");
 assert.equal(breakdown.items.toolResults[0].raw, true);
 assert.match(breakdown.items.contextFiles[0].source, /provider payload unavailable/);
});
