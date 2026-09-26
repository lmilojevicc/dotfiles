import assert from "node:assert/strict";
import test from "node:test";
import contextUsageExtension, { showTextPreview } from "../index.ts";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
test("Vim keys navigate long detail lists, keep viewport bounded, and back out", async () => {
	const components: any[] = [];
	let handler: any;
	contextUsageExtension({ registerCommand: (_: string, config: any) => { handler = config.handler; },
		getAllTools: () => Array.from({ length: 60 }, (_, i) => ({ name: `tool-${i}`, description: `description ${i}`, parameters: { type: "object" } })) } as any);
	const ctx = { mode: "tui", model: { contextWindow: 10000 }, getContextUsage: () => ({ tokens: null, percent: null, contextWindow: 10000 }),
		getSystemPrompt: () => "system", getSystemPromptOptions: () => ({ selectedTools: Array.from({ length: 60 }, (_, i) => `tool-${i}`), skills: [], contextFiles: [] }),
		sessionManager: { buildContextEntries: () => [] }, ui: { custom: (factory: any) => new Promise((resolve) => {
			components.push(factory({ mode: "inline", terminal: { rows: 18, columns: 80 }, requestRender() {} }, theme, null, resolve));
		}) } };
	const run = handler("", ctx);
	const root = components[0]; root.render(76);
	root.handleInput("G"); assert.match(root.render(76).join("\n"), /› Free space/);
	root.handleInput("g"); assert.match(root.render(76).join("\n"), /› System prompt/);
	root.handleInput("j"); root.handleInput("j"); root.handleInput("j"); root.handleInput("l");
	await new Promise<void>((resolve) => setImmediate(resolve));
	const list = components[1]; list.render(76);
	list.handleInput("G"); assert.match(list.render(76).join("\n"), /› tool-59/);
	list.handleInput("\x04"); assert.match(list.render(76).join("\n"), /› tool-59/, "half-page down clamps at end");
	list.handleInput("\x15"); assert.match(list.render(76).join("\n"), /› tool-5[0-9]/);
	list.handleInput("pageUp"); list.handleInput("g"); assert.match(list.render(76).join("\n"), /› tool-0/);
	list.handleInput("h");
	await new Promise<void>((resolve) => setImmediate(resolve));
	components[2].render(76); components[2].handleInput("q"); await run;
});
test("raw source preview keeps Markdown characters and supports Vim scroll", async () => {
	let component: any;
	const preview = showTextPreview({ ui: { custom: (factory: any) => new Promise((resolve) => {
		component = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} }, theme, null, resolve);
	}) } } as any, "Raw", Array.from({ length: 70 }, (_, i) => `**${i}** <xml>`).join("\n"));
	assert.match(component.render(64).join("\n"), /\*\*0\*\* <xml>/);
	component.handleInput("G"); assert.match(component.render(64).join("\n"), /\*\*69\*\*/);
	component.handleInput("g"); assert.match(component.render(64).join("\n"), /1-13 \/ 70 lines/);
	component.handleInput("\x04"); assert.match(component.render(64).join("\n"), /7-19 \/ 70 lines/);
	component.handleInput("h"); await preview;
});
