import assert from "node:assert/strict";
import test from "node:test";
import contextUsageExtension from "../index.ts";
import { formatUsageRow } from "../dialog.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

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
					const count = dialogCount++;
					if (count === 0) panels.push(rendered);
					if (count === 2) previews.push(rendered);
					component.handleInput(count < 2 ? "\r" : "\x1b");
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
	assert.match(app.notices[0].message, /System prompt: 6 estimated tokens \(0.6% window\)/);
	assert.match(app.notices[0].message, /Other \(unattributed\): 44 estimated tokens/);
	assert.match(app.notices[0].message, /Free space: 950 estimated tokens/);
	assert.equal(app.dialogCount, 0);
});

test("/context falls back to content estimates when usage is unknown after compaction", async () => {
	const app = runtime("print", { tokens: null, percent: null, contextWindow: 100 });
	await app.run();
	assert.match(app.notices[0].message, /System prompt: 6 estimated tokens/);
	assert.match(app.notices[0].message, /Free space: 94 estimated tokens/);
});

test("/context reports estimates with no model, usage, or known context window", async () => {
	const app = runtime("json");
	await app.run();
	assert.match(app.notices[0].message, /System prompt: 6 estimated tokens/);
	assert.match(app.notices[0].message, /Free space: n\/a estimated tokens \(n\/a window\)/);
	assert.doesNotMatch(app.notices[0].message, /NaN|Infinity/);
});

test("long item labels truncate before numeric columns at minimum dialog width", () => {
	const line = formatUsageRow({ label: "very-long-source-name-which-would-overflow-the-panel", tokens: 123 }, true, 1000, 200, 32);
	assert.equal(visibleWidth(line), 32);
	assert.match(line.replace(/\x1b\[[0-9;]*m/g, ""), /^ › very.*…  123 · 12\.3% · 61\.5%\s*$/);
	const unknown = formatUsageRow({ label: "Free space", tokens: null }, false, 0, 0, 32);
	assert.match(unknown, /Free space\s+n\/a · n\/a · n\/a/);
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

test("/context Free space shows window share but no used share in root TUI", async () => {
	const app = runtime("tui", { tokens: 50, percent: 5, contextWindow: 1_000 });
	await app.run();
	const root = app.panels[0].join("\n");
	assert.match(root, /CATEGORIES — reconciled est; window%, used%/);
	assert.match(root, /Free space\s+950 est · 95\.0% win · n\/a parent/);
	assert.match(root, /Other \(unattributed\)\s+44 est · 4\.4% win · 88\.0% parent/);
});
