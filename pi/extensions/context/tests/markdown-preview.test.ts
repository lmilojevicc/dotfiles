import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import contextUsageExtension, { collectContextBreakdown, showTextPreview } from "../index.ts";
import { wrapRawLines } from "../format.ts";

initTheme("dark");
const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
const theme = {
 fg: (_color: string, text: string) => text,
 bg: (_color: string, text: string) => text,
 bold: (text: string) => text,
};
const terminal = () => ({ rows: 24, columns: 100 });
const status = (lines: string[]) => {
 const match = stripSgr(lines.at(-2)!).match(/(\d+)-(\d+) \/ (\d+) lines/)!;
 assert.ok(match, "line range remains visible");
 const [start, end, total] = match.slice(1).map(Number);
 assert.ok(start >= 1 && start <= end && end <= total);
 return { start, end, total };
};
function assertMarkdown(lines: string[], heading: string) {
 const body = lines.slice(3, -3).join("\n");
 assert.ok(stripSgr(body).includes(heading));
 assert.ok(!stripSgr(body).includes(`# ${heading}`));
 assert.match(body, /\x1b\[[0-9;]*m/, "document body uses the installed Markdown theme");
 assert.match(lines.at(-2)!, /\[r\] raw/);
}

// Exercise the registered command and its actual home -> category -> document path.
async function navigate(ctx: any, category: number, item: number, inspect: (component: any, term: any) => void, tools: any[] = []) {
 let handler: any;
 let dialogs = 0;
 contextUsageExtension({
  registerCommand: (_name: string, command: any) => { handler = command.handler; },
  getAllTools: () => tools,
 } as any);
 await handler("", {
  mode: "tui", model: { contextWindow: 10000 }, getContextUsage: () => undefined,
  ...ctx,
  ui: { custom: (factory: any) => new Promise((resolve) => {
   const term = terminal();
   const component = factory({ mode: "inline", terminal: term, requestRender() {} }, theme, null, resolve);
   component.render(80);
   switch (dialogs++) {
    case 0:
     for (let n = 0; n < category; n++) component.handleInput("j");
     component.handleInput("\r");
     break;
    case 1:
     for (let n = 0; n < item; n++) component.handleInput("j");
     component.handleInput("\r");
     break;
    case 2:
     inspect(component, term);
     component.handleInput("\x1b");
     break;
    default: component.handleInput("\x1b");
   }
  }) },
 });
 assert.equal(dialogs, 5, "document returns through the submenu to home");
}

const emptySession = { buildContextEntries: () => [] };
test("/context system prompt defaults to styled Markdown; r exposes complete reversible source and restores a bounded Markdown viewport", async () => {
 const suffix = Array.from({ length: 45 }, (_, n) => `\n\nSection ${n}\n===`).join("");
 const source = "# System heading  \n\n**strong** and \\*literal\\*\n\tindent\r\n\\t literal\x1b[2J\x07\x9b0m\n" + "x".repeat(180) + "TAIL" + suffix;
 const encoded = "# System heading  \n\n**strong** and \\\\*literal\\\\*\n\\tindent\\r\n\\\\t literal\\x1b[2J\\x07\\x9b0m\n" + "x".repeat(180) + "TAIL" + suffix;
 const ctx = { getSystemPrompt: () => source, getSystemPromptOptions: () => ({ selectedTools: [] }), sessionManager: emptySession };
 const before = collectContextBreakdown(ctx as any, []);
 await navigate(ctx, 0, 0, (component, term) => {
  const first = component.render(80);
  assertMarkdown(first, "System heading");
  assert.match(stripSgr(first.join("\n")), /strong and \*literal\*/);
  assert.doesNotMatch(stripSgr(first.join("\n")), /\\\*literal/);
  const markdownTotal = status(first).total;
  component.handleInput("G");
  assert.equal(status(component.render(80)).end, markdownTotal);
  component.handleInput("r");
  const raw = component.render(80);
  assert.match(raw[1], /controls escaped/);
  assert.match(raw.at(-2)!, /\[r\] markdown/);
  assert.equal(status(raw).start, 1);
  const expected = wrapRawLines(encoded, 76);
  assert.equal(status(raw).total, expected.length);
  const seen = new Set<number>();
  while (true) {
   const lines = component.render(80);
   const range = status(lines);
   assert.ok(lines.every((line: string) => visibleWidth(line) === 80));
   for (let n = range.start - 1; n < range.end; n++) {
    assert.equal(lines[3 + n - (range.start - 1)].slice(2, 78), expected[n].padEnd(76));
    seen.add(n);
   }
   if (range.end === range.total) break;
   component.handleInput("\x1b[6~"); // PgDn
  }
  assert.equal(seen.size, expected.length, "every raw row, including wrapped tails and whitespace, is accessible");
  const decoded = encoded.replace(/\\(\\|t|r|x[0-9a-f]{2})/g, (_match, code) =>
   code === "\\" ? "\\" : code === "t" ? "\t" : code === "r" ? "\r" : String.fromCharCode(parseInt(code.slice(1), 16)));
  assert.equal(decoded, source);
  component.handleInput("r");
  assertMarkdown(component.render(80), "System heading");
  assert.equal(status(component.render(80)).start, 1);
  assert.equal(status(component.render(80)).total, markdownTotal);
  component.handleMouse({ type: "wheel", wheelDelta: 1 });
  assert.equal(status(component.render(80)).start, 4);
  component.handleInput("G");
  term.rows = 16;
  term.columns = 66;
  component.invalidate();
  const resized = component.render(64);
  assert.ok(resized.every((line: string) => visibleWidth(line) === 64));
  status(resized);
  component.handleInput("G");
  const end = status(component.render(64));
  assert.equal(end.end, end.total);
  component.handleInput("r");
  component.render(44);
  component.handleInput("G");
  component.render(44);
  component.handleInput("r");
  assertMarkdown(component.render(44), "System heading");
  assert.equal(status(component.render(44)).start, 1);
 });
 assert.deepEqual(collectContextBreakdown(ctx as any, []), before, "preview modes never mutate source or accounting");
});

test("/context memory and full SKILL.md render by default; advertisements and tool schemas stay raw", async () => {
 const directory = mkdtempSync(join(tmpdir(), "context-markdown-"));
 try {
  const filePath = join(directory, "SKILL.md");
  writeFileSync(filePath, "# Skill heading\n\n**instructions**");
  const skill = { name: "helper", description: "# advertisement", filePath };
  const memory = "# Memory heading\n\n**remember**";
  const ctx = {
   getSystemPrompt: () => `${memory}\n${formatSkillsForPrompt([skill])}`,
   getSystemPromptOptions: () => ({ selectedTools: ["lookup"], skills: [skill], contextFiles: [{ path: "AGENTS.md", content: memory }] }),
   sessionManager: emptySession,
  };
  await navigate(ctx, 1, 0, (component) => assertMarkdown(component.render(80), "Memory heading"));
  await navigate(ctx, 2, 1, (component) => {
   assertMarkdown(component.render(80), "Skill heading");
   component.handleInput("r");
   assert.match(component.render(80).join("\n"), /# Skill heading/);
  });
  for (const category of [2, 3]) {
   await navigate(ctx, category, 0, (component) => {
    const before = component.render(80);
    assert.match(before[1], /controls escaped/);
    assert.doesNotMatch(before.at(-2)!, /\[r\]/);
    assert.match(before.join("\n"), category === 2 ? /<description># advertisement<\/description>/ : /"description": "# schema"/);
    component.handleInput("r");
    assert.deepEqual(component.render(80), before, "structured source stays raw");
   }, [{ name: "lookup", description: "# schema", parameters: { type: "object" } }]);
  }
 } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("document rendering sanitizes all terminal control bytes without corrupting Markdown escapes", async () => {
 const controls = Array.from({ length: 160 }, (_, n) => n).filter((n) => n < 32 || n >= 127).map((n) => String.fromCharCode(n)).join("");
 const content = "# Safe\n\n\\*literal\\*\n\n" + controls + "\n\x1b]52;c;YQ==\x07\x1b[31mRED\x1b[2J\x9b31m\x9d0;title\x9c\n\n```text\n\x1b[2J\n```";
 let component: any;
 const run = showTextPreview({ ui: { custom: (factory: any) => new Promise((resolve) => {
  component = factory({ mode: "inline", terminal: terminal(), requestRender() {} }, theme, null, resolve);
 }) } } as any, "Title\x1b[2J\nZ", content);
 for (const mode of ["initial", "raw", "markdown"]) {
  if (mode !== "initial") component.handleInput("r");
  component.handleInput("\x1b[H");
  const first = component.render(80);
  if (mode !== "raw") {
   assertMarkdown(first, "Safe");
   assert.match(stripSgr(first.join("\n")), /\*literal\*/);
  }
  assert.match(first[1], /Title\\x1b\[2J\\nZ/);
  while (true) {
   const lines = component.render(80);
   const plain = stripSgr(lines.join("\n"));
   assert.doesNotMatch(plain, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
   assert.doesNotMatch(lines.join("\n"), /\x1b\[31m/);
   if (status(lines).end === status(lines).total) break;
   component.handleInput("\x1b[6~");
  }
 }
 component.handleInput("\x1b");
 await run;
});

test("natural-language session leaves render Markdown while structured content stays raw", () => {
 const text = "# Message";
 const result = collectContextBreakdown({
  getSystemPrompt: () => "", getSystemPromptOptions: () => ({ selectedTools: [] }),
  sessionManager: { buildContextEntries: () => [
   { type: "message", message: { role: "user", content: text } },
   { type: "message", message: { role: "assistant", content: [{ type: "text", text }, { type: "thinking", thinking: text }] } },
   { type: "message", message: { role: "branchSummary", summary: text } },
   { type: "message", message: { role: "compactionSummary", summary: text } },
   { type: "compaction", summary: text },
   { type: "branch_summary", summary: text },
   { type: "custom_message", customType: "note", content: text },
   { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
   { type: "custom_message", customType: "structured", content: { heading: text } },
  ] },
 } as any, []);
 assert.equal(result.items.contextFiles.length, 10);
 assert.ok(result.items.contextFiles.slice(0, 8).every((item) => item.raw === false && item.content === text));
 assert.ok(result.items.contextFiles.slice(8).every((item) => item.raw === true));
});
