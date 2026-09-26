import assert from "node:assert/strict";
import test from "node:test";
import contextUsageExtension from "../index.ts";

type Handler = (args: string, ctx: any) => Promise<void>;

function runtime(mode: string, usage?: { tokens: number | null; percent: number | null; contextWindow: number }) {
	let name = "";
	let handler: Handler | undefined;
	let toolReads = 0;
	const notices: Array<{ message: string; level: string }> = [];
	const panels: string[][] = [];
	const previews: string[][] = [];
	let dialogCount = 0;
	const ctx = {
		mode,
		model: undefined,
		getContextUsage: () => usage,
		getSystemPrompt: () => "example system prompt",
		getSystemPromptOptions: () => ({ selectedTools: [], contextFiles: [], skills: [] }),
		sessionManager: { buildContextEntries: () => [] },
		ui: {
			notify: (message: string, level: string) => notices.push({ message, level }),
			custom: async (factory: any) => {
				const tui = { mode: "inline", terminal: { rows: 24, columns: 80 }, requestRender() {} };
				const theme = {
					fg: (_color: string, text: string) => text,
					bg: (_color: string, text: string) => text,
					bold: (text: string) => text,
				};
				return await new Promise((resolve) => {
					const component = factory(tui, theme, null, resolve);
					const rendered = component.render(64);
					if (dialogCount++ === 0) {
						panels.push(rendered);
						component.handleInput("\r");
					} else if (dialogCount === 2) {
                        component.handleInput("\r");
                    } else if (dialogCount === 3) {
                        previews.push(rendered);
                        component.handleInput("\x1b");
					} else {
						component.handleInput("\x1b");
					}
				});
			},
		},
	};
	contextUsageExtension({
		registerCommand: (command: string, options: { handler: Handler }) => {
			name = command;
			handler = options.handler;
		},
		getAllTools: () => {
			toolReads++;
			return [];
		},
	} as any);
	return {
		name,
		notices,
		panels,
		previews,
		get toolReads() { return toolReads; },
		get dialogCount() { return dialogCount; },
		run: () => handler!("", ctx),
	};
}

test("/context registers and reports a breakdown in non-TUI mode without writing session entries", async () => {
	const app = runtime("rpc", { tokens: 50, percent: 5, contextWindow: 1_000 });
	assert.equal(app.name, "context");
	await app.run();
	assert.equal(app.toolReads, 1);
	assert.deepEqual(app.notices, [{
		message: "System prompt: 6 tokens\nMemory: 0 tokens\nSkills: 0 tokens\nTools definition: 0 tokens\nTool results: 0 tokens\nContext: 0 tokens\nOther: 44 tokens\nFree space: 950 tokens",
		level: "info",
	}]);
	assert.equal(app.dialogCount, 0);
});

test("/context falls back to content estimates when usage is unknown after compaction", async () => {
	const app = runtime("print", { tokens: null, percent: null, contextWindow: 100 });
	await app.run();
	assert.match(app.notices[0].message, /System prompt: 6 tokens/);
	assert.match(app.notices[0].message, /Free space: 94 tokens/);
});

test("/context reports estimates with no model, usage, or known context window", async () => {
	const app = runtime("json");
	await app.run();
	assert.match(app.notices[0].message, /System prompt: 6 tokens/);
	assert.match(app.notices[0].message, /Free space: 0 tokens/);
	assert.doesNotMatch(app.notices[0].message, /NaN|Infinity/);
});

test("root gg requires consecutive keyboard g's within one home visit", async () => {
 let handler: Handler | undefined;
 let homeVisits = 0;
 let dialogs = 0;
 const selected = (component: any) => component.render(64).find((line: string) => line.includes("› "));
 const ctx = {
  mode: "tui",
  model: { contextWindow: 1000 },
  getContextUsage: () => ({ tokens: 50, percent: 5, contextWindow: 1000 }),
  getSystemPrompt: () => "prompt",
  getSystemPromptOptions: () => ({ contextFiles: [], skills: [], selectedTools: [] }),
  sessionManager: { buildContextEntries: () => [] },
  ui: { custom: (factory: any) => new Promise((resolve) => {
   const component = factory({ mode: "inline", terminal: { rows: 24, columns: 80 }, requestRender() {} }, {
    fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text,
   }, null, resolve);
   component.render(64);
   if (dialogs++ === 0) {
    homeVisits++;
    component.handleInput("G");
    component.handleInput("g");
    component.handleInput("\r"); // Open last category; the pending g must not leak to the next home.
   } else if (dialogs === 2) {
    component.handleInput("\x1b"); // Close submenu.
   } else {
    homeVisits++;
    assert.match(selected(component), /Context/);
    component.handleInput("g");
    assert.match(selected(component), /Context/, "reopened home starts with no pending g");
    component.handleMouse({ type: "move", screenX: 20, screenY: 8 });
    component.handleInput("g");
    assert.match(selected(component), /Context/, "mouse move interrupts gg");
    component.handleInput("k");
    assert.match(selected(component), /Tool results/);
    component.handleInput("g");
    assert.match(selected(component), /Tool results/, "unrelated keyboard action interrupts gg");
    component.handleInput("g");
    assert.match(selected(component), /System prompt/, "only consecutive g's return home to first row");
    component.handleInput("\x1b");
   }
  }) },
 };
 contextUsageExtension({
  registerCommand: (_name: string, options: { handler: Handler }) => { handler = options.handler; },
  getAllTools: () => [],
 } as any);
 await handler!("", ctx);
 assert.equal(homeVisits, 2);
});

test("/context opens a selectable TUI breakdown and a text preview, then closes both", async () => {
	const app = runtime("tui", { tokens: 50, percent: 5, contextWindow: 1_000 });
	await app.run();
	assert.equal(app.dialogCount, 5);
	assert.match(app.panels[0].join("\n"), /Context Usage/);
	assert.match(app.panels[0].join("\n"), /System prompt/);
	assert.match(app.previews[0].join("\n"), /example system prompt/);
	assert.deepEqual(app.notices, []);
});
