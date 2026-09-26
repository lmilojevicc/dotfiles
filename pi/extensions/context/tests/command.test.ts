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

test("/context opens a selectable TUI breakdown and a text preview, then closes both", async () => {
	const app = runtime("tui", { tokens: 50, percent: 5, contextWindow: 1_000 });
	await app.run();
	assert.equal(app.dialogCount, 3);
	assert.match(app.panels[0].join("\n"), /Context Usage/);
	assert.match(app.panels[0].join("\n"), /System prompt/);
	assert.match(app.previews[0].join("\n"), /example system prompt/);
	assert.deepEqual(app.notices, []);
});
