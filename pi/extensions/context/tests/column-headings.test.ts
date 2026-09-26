import assert from "node:assert/strict";
import test from "node:test";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import contextUsageExtension, { showCategoryMenu, showTextPreview, type ContextPart } from "../index.ts";

const theme = {
 fg: (_color: string, text: string) => text,
 bg: (color: string, text: string) => `\x1b[48;5;${color === "selectedBg" ? 211 : 212}m${text}\x1b[49m`,
 bold: (text: string) => text,
};

function harness(rows = 24, columns = 100) {
 let component: any;
 let options: any;
 let completions = 0;
 const ui = { custom: (factory: any, config: any) => new Promise((resolve) => {
  options = config.overlayOptions;
  component = factory({ terminal: { rows, columns }, requestRender() {} }, theme, null,
   (value: unknown) => { completions++; resolve(value); });
 }) };
 return { ui, get component() { return component; }, get options() { return options; }, get completions() { return completions; } };
}

function root(ui: any, prompt = "prompt") {
 let handler: any;
 contextUsageExtension({ registerCommand: (_name: string, command: any) => { handler = command.handler; }, getAllTools: () => [] } as any);
 return handler("", {
  mode: "tui", getContextUsage: () => ({ tokens: 50, percent: 5, contextWindow: 1000 }),
  getSystemPrompt: () => prompt, getSystemPromptOptions: () => ({ selectedTools: [] }),
  sessionManager: { buildContextEntries: () => [] }, ui,
 });
}

const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

// End boundaries are shared by right-aligned headings and values, including the % sign.
function assertNumericAlignment(rendered: string[], parent: boolean) {
 const lines = rendered.map(stripSgr);
 const heading = lines[5];
 assert.equal(lines.filter((line) => line.includes("Est. tokens")).length, 1);
 const categoryLabel = visibleWidth(heading) >= 40 ? "% category" : "% cat.";
 const labels = parent ? ["Est. tokens", "% window", categoryLabel] : ["Est. tokens", "% window"];
 assert.doesNotMatch(heading, /% parent/);
 const ends = labels.map((label) => heading.indexOf(label) + label.length);
 assert.ok(labels.every((label) => heading.includes(label)));
 assert.equal(ends.at(-1), visibleWidth(heading) - 1, "last numeric heading ends at the inner right edge");
 for (const line of lines.filter((line) => line.includes("■"))) {
  const values = [...line.matchAll(/\d+(?:\.\d+)?k?%?/g)].slice(-labels.length);
  assert.deepEqual(values.map((value) => visibleWidth(line.slice(0, value.index! + value[0].length))), ends, line);
 }
 assert.doesNotMatch(lines.at(-2)!, /est\.|tokens|% window|% category|% cat\./i, "footer has navigation, not a numeric legend");
}

function assertFullWidthBody(lines: string[], width: number) {
 assert.ok(lines.every((line) => visibleWidth(line) === width));
 assert.match(stripSgr(lines[3]), new RegExp(`^│ [█░]{${width - 4}} │$`), "bar fills the width with one cell of padding at each end");
 const selection = lines.find((line) => line.includes("\x1b[48;5;211m"))!;
 const selectedBody = selection.match(/\x1b\[48;5;211m(.*?)\x1b\[49m/)![1];
 assert.equal(visibleWidth(selectedBody), width - 2, "selection covers every inner column");
 assert.doesNotMatch(selectedBody, /│/, "selection excludes the borders");
}

for (const width of [80, 64, 44]) {
 test(`root headings align above all numeric values at ${width} columns and cannot be selected`, async () => {
  const h = harness();
  const run = root(h.ui);
  const lines = h.component.render(width);
  assertNumericAlignment(lines, false);
  assertFullWidthBody(lines, width);
  const labelWidth = width - 28;
  assert.equal(sliceByColumn(stripSgr(lines[6]), 5, labelWidth), "System prompt".padEnd(labelWidth));
  // 24-row terminal gives top=1, heading row=7 (1-based).
  h.component.handleMouse({ type: "press", button: "left", screenX: 50, screenY: 6 });
  h.component.handleInput("\x1b[<0;51;7M");
  assert.equal(h.completions, 0);
  h.component.handleInput("G");
  assert.match(h.component.render(width).find((line: string) => line.includes("› ")), /Context/);
  h.component.handleInput("g"); h.component.handleInput("g");
  assert.match(h.component.render(width).find((line: string) => line.includes("› ")), /System prompt/);
  h.component.handleInput("\x1b");
  await run;
 });

 for (const category of ["System prompt", "Memory", "Skills", "Tools definition", "Tool results", "Context"]) {
  test(`${category} headings align at ${width} columns across long labels, scroll and mouse selection`, async () => {
   const h = harness();
   const items = Array.from({ length: 30 }, (_, index) => ({ label: "界🙂very long label ".repeat(8), tokens: index + 1, content: String(index), source: "Local source" }));
   const run = showCategoryMenu({ ui: h.ui } as any, { label: category, tokens: 465, color: "accent" }, items, 1000);
   const initial = h.component.render(width);
   assertNumericAlignment(initial, true);
   assertFullWidthBody(initial, width);
   const labelWidth = width - 39;
   const label = sliceByColumn(stripSgr(initial[6]), 5, labelWidth);
   assert.equal(visibleWidth(label), labelWidth);
   assert.match(label, /… ?$/, "long wide labels use all available cells before numeric columns");
   assert.ok(visibleWidth(label.trimEnd()) >= labelWidth - 1);
   h.component.handleMouse({ type: "press", button: "left", screenX: 50, screenY: 6 });
   h.component.handleInput("\x1b[<0;51;7M");
   assert.equal(h.completions, 0, "both mouse routes ignore the heading");
   h.component.handleInput("G");
   const scrolled = h.component.render(width);
   assert.equal(scrolled[5], initial[5], "heading stays above the scrolling body");
   assertNumericAlignment(scrolled, true);
   assertFullWidthBody(scrolled, width);
   assert.match(scrolled.at(-2), /19-30\/30/);
   // First visible item is 18 after scrolling; heading was inserted before row 8.
   const rightInnerX = Math.floor((100 - width) / 2) + width - 2;
   h.component.handleMouse({ type: "move", screenX: rightInnerX, screenY: 7 });
   const hover = h.component.render(width)[6].match(/\x1b\[48;5;212m(.*?)\x1b\[49m/)![1];
   assert.equal(visibleWidth(hover), width - 2, "right-edge hover covers the full row");
   if (category === "Context") h.component.handleInput(`\x1b[<0;${rightInnerX + 1};8M`);
   else h.component.handleMouse({ type: "press", button: "left", screenX: rightInnerX, screenY: 7 });
   assert.equal((await run)?.content, "18");
  });
 }
}

test("category label stays clear and aligned at the narrow layout boundary", async () => {
 for (const width of [38, 39, 40]) {
  const h = harness();
  const run = showCategoryMenu({ ui: h.ui } as any, { label: "Tools definition", tokens: 100, color: "accent" },
   [{ label: "Tool", tokens: 20, content: "schema", source: "Tool definition" }], 1000);
  const lines = h.component.render(width);
  assertNumericAlignment(lines, true);
  assertFullWidthBody(lines, width);
  assert.ok(stripSgr(lines[5]).includes(width >= 40 ? "% category" : "% cat."));
  h.component.handleInput("\x1b");
  await run;
 }
});

test("root, short/empty/long categories and raw previews share responsive frame dimensions", async () => {
 const category: ContextPart = { label: "Memory", tokens: 100, color: "error" };
 const item = { label: "AGENTS.md", tokens: 1, content: "text", source: "Memory file" };
 for (const [columns, rows] of [[120, 50], [80, 24], [66, 19], [46, 12], [40, 24], [30, 8], [3, 3]]) {
  for (const view of ["root", "empty", "short", "long", "raw"]) {
   const h = harness(rows, columns);
   const run = view === "root" ? root(h.ui) : view === "raw"
    ? showTextPreview({ ui: h.ui } as any, "Raw source", "text\n".repeat(100), true)
    : showCategoryMenu({ ui: h.ui } as any, category, view === "empty" ? [] : Array(view === "long" ? 100 : 1).fill(item), 1000);
   assert.deepEqual(h.options, { anchor: "center", width: 80, minWidth: 44, maxHeight: "90%", margin: 1 });
   // Pi clamps configured width/minWidth to the available width after margins.
   const width = Math.max(1, Math.min(h.options.width, columns - 2));
   const height = Math.max(1, Math.min(30, Math.floor(rows * 0.9), rows - 2));
   const lines = h.component.render(width);
   assert.equal(lines.length, height, `${view} ${columns}x${rows}`);
   assert.ok(lines.every((line: string) => visibleWidth(line) === width), `${view} width`);
   if (view === "raw") assert.doesNotMatch(lines.join("\n"), /Est\. tokens|% window|% category|% cat\./);
   else if (width >= 38 && height >= 10) assertNumericAlignment(lines, view !== "root");
   h.component.handleInput("\x1b");
   await run;
  }
 }
});

test("short root viewport scrolls selected categories below the fixed heading and refreshes hitboxes", async () => {
 const h = harness(14);
 const run = root(h.ui);
 const first = h.component.render(64);
 assert.equal(first.length, 12);
 h.component.handleInput("G");
 const last = h.component.render(64);
 assert.equal(first[5], last[5]);
 assert.match(last[8], /› .*Context/);
 h.component.handleMouse({ type: "wheel", wheelDelta: 1 });
 const bottom = h.component.render(64);
 assert.equal(bottom[5], first[5]);
 assert.match(bottom[6], /Context/);
 assert.match(bottom[7], /Other/);
 assert.match(bottom[8], /Free space/);
 h.component.handleInput("\x1b[5~"); // PageUp
 assert.match(h.component.render(64)[6], /Skills/);
 h.component.handleInput("\x1b[6~"); // PageDown
 h.component.render(64);
 h.component.handleMouse({ type: "press", button: "left", screenX: 50, screenY: 7 });
 assert.equal(h.completions, 1, "scrolled Context hitbox opens the correct category");
 await new Promise<void>((resolve) => setImmediate(resolve));
 assert.match(h.component.render(64)[1], /Context/);
 h.component.handleInput("\x1b"); // Back to root.
 await new Promise<void>((resolve) => setImmediate(resolve));
 h.component.handleInput("g"); h.component.handleInput("g");
 assert.match(h.component.render(64)[6], /› .*System prompt/);
 h.component.handleInput("\x1b");
 await run;
});

test("empty submenu heading and padded body are not selectable", async () => {
 const h = harness();
 const run = showCategoryMenu({ ui: h.ui } as any, { label: "Skills", tokens: 0, color: "warning" }, [], 1000);
 assertNumericAlignment(h.component.render(44), true);
 h.component.handleInput("\r");
 h.component.handleMouse({ type: "press", button: "left", screenX: 50, screenY: 7 });
 assert.equal(h.completions, 0);
 h.component.handleInput("\x1b");
 assert.equal(await run, undefined);
});

for (const columns of [82, 66, 46]) {
 test(`successive root/category/preview mouse coordinates share one frame on a ${columns}-column terminal`, async () => {
  const h = harness(24, columns);
  const run = root(h.ui, Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
  const width = columns - 2;
  const next = () => new Promise<void>((resolve) => setImmediate(resolve));
  const render = () => {
   const lines = h.component.render(width);
   assert.equal(lines.length, 21);
   assert.ok(lines.every((line: string) => visibleWidth(line) === width));
   assert.deepEqual(h.options, { anchor: "center", width: 80, minWidth: 44, maxHeight: "90%", margin: 1 });
   return lines;
  };
  const press = (screenX: number, screenY: number) => h.component.handleMouse({ type: "press", button: "left", screenX, screenY });
  const close = async () => { press(columns - 4, 2); await next(); };
  assert.match(render()[1], /Context Usage/);
  h.component.handleMouse({ type: "move", screenX: width - 1, screenY: 8 });
  const hover = render()[7].match(/\x1b\[48;5;212m(.*?)\x1b\[49m/)![1];
  assert.equal(visibleWidth(hover), width - 2, "root hover reaches the inner right edge");
  press(width - 1, 6); // Heading at terminal row 7.
  assert.equal(h.completions, 0);
  press(width - 1, 7); // Inner right edge of first category at terminal row 8.
  await next();
  assert.match(render()[1], /System prompt/);
  press(width - 1, 6);
  assert.equal(h.completions, 1, "category heading has no hitbox");
  // Exercise raw SGR at the same far-right cell as normalized mouse events.
  h.component.handleInput(`\x1b[<0;${width};8M`);
  await next();
  assert.match(render()[3], /line 1/);
  h.component.handleMouse({ type: "wheel", wheelDelta: 1 });
  assert.match(render().at(-2), /4-18 \/ 100 lines/);
  // Shared frame left=1/top=1; preview scrollbar occupies terminal column width, rows 5..19.
  assert.deepEqual(press(width - 1, 4), { handled: true, capture: true });
  h.component.handleMouse({ type: "drag", button: "left", screenX: 0, screenY: 18 });
  h.component.handleMouse({ type: "release", button: "left", screenX: 0, screenY: 18 });
  assert.match(render().at(-2), /86-100 \/ 100 lines/);
  await close();
  assert.match(render()[1], /System prompt/);
  await close();
  assert.match(render()[1], /Context Usage/);
  await close();
  await run;
  assert.equal(h.completions, 5);
 });
}

for (const width of [80, 64, 44]) {
 for (const raw of [true, false]) {
  test(`${raw ? "raw" : "Markdown"} source preview fills usable inner width at ${width} columns`, async () => {
   const h = harness(50, 120);
   const bodyWidth = width - 4; // Borders, left padding and the scrollbar lane.
   const content = "x".repeat(bodyWidth * 3);
   const run = showTextPreview({ ui: h.ui } as any, "Source", content, raw);
   const lines = h.component.render(width);
   assert.equal(lines.length, 30);
   assert.ok(lines.every((line: string) => visibleWidth(line) === width));
   for (const row of lines.slice(3, 6)) assert.equal(stripSgr(row), `│ ${"x".repeat(bodyWidth)} │`);
   assert.match(lines.at(-2), /1-3 \/ 3 lines/);
   h.component.handleInput("\x1b");
   await run;
  });
 }

 test(`raw preview preserves wide graphemes and escaped controls at ${width} columns`, async () => {
  const h = harness(50, 120);
  const content = "# " + "界🙂e\u0301".repeat(20) + "\t\r\x1b\\TAIL";
  const escaped = "# " + "界🙂e\u0301".repeat(20) + "\\t\\r\\x1b\\\\TAIL";
  const run = showTextPreview({ ui: h.ui } as any, "Raw source", content, true);
  const lines = h.component.render(width);
  assert.ok(lines.every((line: string) => visibleWidth(line) === width));
  const body = lines.slice(3, -3).map((line: string) => sliceByColumn(stripSgr(line), 2, width - 4).trimEnd());
  assert.equal(body.join(""), escaped, "wrapping neither drops source columns nor emits control sequences");
  assert.doesNotMatch(body.join(""), /\x1b|\r|\t|…/);
  h.component.handleInput("\x1b");
  await run;
 });
}
