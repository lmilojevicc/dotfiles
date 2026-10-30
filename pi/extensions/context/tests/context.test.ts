// escCloseHitbox 的契约：
// [esc] 按钮位于弹框标题行（box 第 2 行）右端，5 列宽；
// bounds 为 0-based 的弹框起点（left/top）+ 宽度。
import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { wrapRawLines } from "../format.ts";
import { projectionOf } from "./session-projection.ts";
import contextUsageExtension, {
	capParts,
	collectContextBreakdown,
	escCloseHitbox,
	hasActiveTextPreview,
	resolveUsedTokens,
	showTextPreview,
} from "../index.ts";

initTheme("dark");

test("context breakdown separates tools, results, and conversation without inflating estimates", () => {
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [{ path: "AGENTS.md", content: "cccc" }],
			skills: [
				{ name: "ok", description: "desc", filePath: "/v" },
				{
					name: "hidden",
					description: "x".repeat(100),
					filePath: "/hidden",
					disableModelInvocation: true,
				},
			],
		}),
		getSystemPrompt: () => "s".repeat(200),
		sessionManager: {
			buildSessionProjection: () => projectionOf([
				{ type: "message", message: { role: "user", content: "uuuuuuuu", timestamp: 0 } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "aaaa" },
							{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
						],
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "1",
						toolName: "read",
						content: "rrrrrrrr",
						timestamp: 0,
					},
				},
				{ type: "compaction", summary: "ssss" },
			]),
		},
	} as any;
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object" },
			promptGuidelines: [],
			sourceInfo: {},
		},
	] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const parts = breakdown.parts;
	assert.deepEqual(
		parts.map(({ label, color }) => [label, color]),
		[
			["System prompt", "accent"],
			["Memory", "error"],
			["Skills", "warning"],
			["Tools definition", "success"],
			["Tool results", "customMessageLabel"],
			["Context", "warning"],
		],
	);
	assert.equal(parts.find((part) => part.label === "System prompt")?.tokens, 50);
	assert.equal(parts.find((part) => part.label === "Memory")?.tokens, 0);
	assert.equal(parts.find((part) => part.label === "Skills")?.tokens, 0);
	assert.match(breakdown.previews.memoryFiles(), /## AGENTS\.md/);
	assert.match(breakdown.previews.memoryFiles(), /cccc/);
	assert.match(breakdown.previews.skills(), /<name>ok<\/name>/);
	assert.doesNotMatch(breakdown.previews.skills(), /hidden/);
	assert.equal(parts.find((part) => part.label === "Tool results")?.tokens, 2);
	assert.equal(parts.find((part) => part.label === "Context")?.tokens, 8);
	assert.equal(breakdown.previews.systemPrompt(), "s".repeat(200));
	assert.equal(typeof breakdown.previews.toolResults, "function", "aggregate previews are assembled on demand");
	assert.match(breakdown.previews.tools(), /Definition: read/);
	assert.match(breakdown.previews.tools(), /"parameters"/);
	assert.doesNotMatch(breakdown.previews.tools(), /Call: read/);
	assert.match(breakdown.previews.toolResults(), /Result: read/);
	assert.match(breakdown.previews.toolResults(), /rrrrrrrr/);
	assert.match(breakdown.previews.contextFiles(), /uuuuuuuu/);
	assert.match(breakdown.previews.contextFiles(), /aaaa/);
	assert.match(breakdown.previews.contextFiles(), /Assistant tool call: read/);
	assert.match(breakdown.previews.contextFiles(), /"path": "a"/);
	assert.match(breakdown.previews.contextFiles(), /Compaction/);

	const fitted = capParts(parts, parts.reduce((sum, part) => sum + part.tokens, 0) + 10);
	assert.deepEqual(fitted, parts, "estimates are not inflated to fill provider usage");
	const fixedTokens = parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
	const capped = capParts(parts, fixedTokens + 5, 4);
	assert.deepEqual(
		capped.slice(0, 4),
		parts.slice(0, 4),
		"system prompt, memory, skills and tools definition stay stable",
	);
	assert.equal(
		capped.reduce((sum, part) => sum + part.tokens, 0),
		fixedTokens + 5,
	);
	const finalParts = [
		...fitted,
		{ label: "Other", tokens: 10, color: "muted" },
		{ label: "Free space", tokens: 100, color: "dim" },
	];
	assert.equal(new Set(finalParts.map((part) => part.color)).size, 7);
});

test("context breakdown attributes embedded memory and skills once", () => {
	const memory = "cccc";
	const skills = [{ name: "ok", description: "desc", filePath: "/v" }];
	const skillsText = formatSkillsForPrompt(skills as any).trim();
	const systemPrompt = `base\n<project_instructions>\n${memory}\n</project_instructions>\n${skillsText}`;
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: [],
			contextFiles: [{ path: "AGENTS.md", content: memory }],
			skills,
		}),
		getSystemPrompt: () => systemPrompt,
		sessionManager: { buildSessionProjection: () => projectionOf([]) },
	} as any;

	const breakdown = collectContextBreakdown(ctx, []);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens ?? -1;
	const memoryTokens = breakdown.parts.find((part) => part.label === "Memory")?.tokens ?? -1;
	const skillsTokens = breakdown.parts.find((part) => part.label === "Skills")?.tokens ?? -1;
	assert.equal(memoryTokens, Math.ceil(memory.length / 4));
	assert.equal(skillsTokens, Math.ceil(skillsText.length / 4));
	assert.equal(systemTokens + memoryTokens + skillsTokens, Math.ceil(systemPrompt.length / 4));
	assert.ok(systemTokens < Math.ceil(systemPrompt.length / 4));
});

test("resolveUsedTokens rejects inconsistent or implausibly small provider usage", () => {
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 7 }, 20_000, 272_000), 19_040);
	assert.equal(resolveUsedTokens({ tokens: 19_000, percent: 7 }, 20_000, 272_000), 19_000);
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 1 / 2_720 }, 20_000, 272_000), 20_000);
	assert.equal(resolveUsedTokens({ tokens: null, percent: null }, 20_000, 272_000), 20_000);
});

test("capParts never produces negative tokens when estimates exceed usage", () => {
	const parts = Array.from({ length: 8 }, (_, index) => ({
		label: String(index),
		tokens: 1,
		color: "dim" as const,
	}));
	const fitted = capParts(parts, 5);
	assert.equal(
		fitted.reduce((sum, part) => sum + part.tokens, 0),
		5,
	);
	assert.ok(fitted.every((part) => part.tokens >= 0));
});

test("escCloseHitbox sits 5 columns wide at the title row's right edge", () => {
	assert.deepEqual(escCloseHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 67,
		endCol: 71,
	});
	assert.deepEqual(escCloseHitbox({ left: 1, top: 1, width: 38 }), {
		row: 3,
		startCol: 34,
		endCol: 38,
	});
	assert.deepEqual(escCloseHitbox({ left: 20, top: 6, width: 50 }), {
		row: 8,
		startCol: 65,
		endCol: 69,
	});
});

/** Capture the preview component after mounting it. */
function textPreviewHarness(
	theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	onMount?: (component: any) => void,
): any {
	let component: any;
	return {
		custom: async (factory: any) =>
			await new Promise<void>((resolve) => {
				component = factory(
					{ terminal: { columns: 80, rows: 24 }, requestRender() {} },
					theme,
					null,
					resolve,
				);
				onMount?.(component);
			}),
		get component() {
			return component;
		},
	};
}

test("showTextPreview highlights and closes from the [esc] mouse hitbox", async () => {
	let escColor = "";
	const ui = textPreviewHarness(
		{
			fg: (color: string, text: string) => {
				if (text === "[esc]") escColor = color;
				return text;
			},
			bold: (text: string) => text,
		},
		(c) => c.render(64),
	);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	assert.equal(hasActiveTextPreview(), true);
	assert.equal(escColor, "muted");
	// 80×24、64 列居中、margin 1 → [esc] 命中 row=3, col=67..71。
	ui.component.handleMouse({ type: "move", button: "none", screenX: 66, screenY: 2 });
	ui.component.render(64);
	assert.equal(escColor, "text", "[esc] hover switches to text color");
	ui.component.handleMouse({ type: "press", button: "left", screenX: 66, screenY: 2 });
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("raw leaf preview wraps a long single line without losing its end", async () => {
 const ui = textPreviewHarness();
 const content = "x".repeat(900) + "🙂TAIL";
 const expected = wrapRawLines(content, 60);
 assert.equal(expected.join(""), content);
 const preview = showTextPreview({ ui } as any, "Raw schema", content, true);
 const first = ui.component.render(64);
 assert.ok(first.every((line: string) => visibleWidth(line) === 64));
 assert.match(first.at(-2), /1-15 \/ 16 lines/);
 ui.component.handleInput("G");
 const last = ui.component.render(64);
 assert.ok(last.every((line: string) => visibleWidth(line) === 64));
 assert.match(last.at(-2), /2-16 \/ 16 lines/);
 assert.match(last.join("\n"), /🙂TAIL/);
 ui.component.handleInput("\x1b");
 await preview;
});

test("showTextPreview scrollbar supports press and drag", async () => {
	const ui = textPreviewHarness();
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const preview = showTextPreview({ ui } as any, "Output", content);
	const initial = ui.component.render(64).join("\n");
	assert.match(initial, /1-15 \/ 100 lines/);
	// scrollbar col=71，body track row=5..19；从顶部 thumb 拖到底部。
	ui.component.handleMouse({ type: "press", button: "left", screenX: 70, screenY: 4 });
	ui.component.handleMouse({ type: "drag", button: "left", screenX: 70, screenY: 18 });
	ui.component.handleMouse({ type: "release", button: "none", screenX: 70, screenY: 18 });
	const dragged = ui.component.render(64).join("\n");
	assert.match(dragged, /86-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});

test("fullscreen routes normalized mouse to /context overlays before viewport scrolling", async () => {
	const writes: string[] = [];
	const terminal = {
		columns: 80, rows: 24,
		write: (data: string) => { writes.push(data); },
		hideCursor() {}, showCursor() {},
	};
	const tui = new TuiAltScreen(terminal as any, false);
	(tui as any).stopped = false;
	tui.beforeTerminalStart();
	const theme = {
		fg: (color: string, text: string) => color === "text" && text === "[esc]" ? "{hover esc}" : text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const components: any[] = [];
	const ctx = {
		mode: "tui", model: { contextWindow: 1000 },
		getContextUsage: () => ({ tokens: 50, percent: 5, contextWindow: 1000 }),
		getSystemPrompt: () => Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"),
		getSystemPromptOptions: () => ({ selectedTools: [], contextFiles: [], skills: [] }),
		sessionManager: { buildSessionProjection: () => projectionOf([]) },
		ui: {
			custom: (factory: any, options: any) => new Promise((resolve) => {
				const component = factory(tui, theme, null, (value: unknown) => {
					handle.hide();
					resolve(value);
				});
				components.push(component);
				const handle = tui.showOverlay(component, options.overlayOptions);
				tui.renderNow();
			}),
		},
	};
	let command: any;
	contextUsageExtension({
		registerCommand: (name: string, options: any) => {
			assert.equal(name, "context");
			command = options.handler;
		},
		getAllTools: () => [],
	} as any);
	const run = command("", ctx);
	const send = (code: number, col: number, row: number, release = false) => {
		tui.handleTerminalInput(`\x1b[<${code};${col};${row}${release ? "m" : "M"}`);
		tui.renderNow();
	};
	assert.equal(components.length, 1);
	// All dialogs: 78 columns, 21 rows centered at (1,1), first category on row 8.
	send(35, 20, 8);
	assert.equal((components[0].render(78).join("\n")).includes("{hover esc}"), false);
	send(0, 20, 8);
	send(0, 20, 8, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(components.length, 2, "category press opens the second menu via fullscreen host");
    assert.match(components[1].render(78).join("\n"), /System prompt · unattri/);
    send(0, 20, 8);
    send(0, 20, 8, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(components.length, 3, "submenu press opens a leaf");
	const preview = components[2];
	assert.match(preview.render(78).join("\n"), /1-15 \/ 100 lines/);
	const top = tui.viewportTop;
	send(65, 25, 10); // wheel down inside preview, not transcript
	assert.match(preview.render(78).join("\n"), /4-18 \/ 100 lines/);
	assert.equal(tui.viewportTop, top);
	// Preview scrollbar: overlay left 1, track column 78, rows 5..19.
	send(0, 78, 5);
	assert.ok(tui.mouseCapture, "scrollbar press captures subsequent drag");
	send(32, 2, 19); // drag outside overlay must still reach captured component
	send(0, 2, 19, true);
	assert.equal(tui.mouseCapture, undefined);
	assert.match(preview.render(78).join("\n"), /86-100 \/ 100 lines/);
	send(35, 75, 3);
	assert.match(preview.render(78).join("\n"), /\{hover esc\}/);
	send(0, 75, 3);
	send(0, 75, 3, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(components.length, 4, "preview esc returns to submenu");
    send(0, 75, 3);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(components.length, 5, "submenu esc returns to main dialog");
	const main = components[4];
	tui.handleTerminalInput("\x1b[B"); // keyboard navigation still works
	tui.renderNow();
	assert.match(main.render(78).join("\n"), /Context Usage/);
	main.handleMouse({ type: "move", screenX: 74, screenY: 2 });
    assert.match(main.render(78).join("\n"), /\{hover esc\}/);
    main.handleInput("\x1b");
	await run;
	assert.equal(hasActiveTextPreview(), false);
	assert.equal(writes.filter((write) => write === "\x1b[?1003h").length, 0,
		"native fullscreen tracking is not overwritten by the overlay");
});

test("showTextPreview normalized mouse handles wheel and captured scrollbar independently of raw input", async () => {
	const ui = textPreviewHarness();
	const preview = showTextPreview({ ui } as any, "Output",
		Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
	ui.component.render(64);
	const mouse = (type: string, screenX: number, screenY: number, wheelDelta?: number) =>
		ui.component.handleMouse({ type, button: "left", screenX, screenY, wheelDelta });
	assert.deepEqual(mouse("wheel", 20, 9, 1), { handled: true });
	assert.match(ui.component.render(64).join("\n"), /4-18 \/ 100 lines/);
	assert.deepEqual(mouse("press", 70, 4), { handled: true, capture: true });
	mouse("drag", 0, 18);
	mouse("release", 0, 18);
	assert.match(ui.component.render(64).join("\n"), /86-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});

async function hoverWrites(tui: Record<string, unknown>): Promise<string[]> {
	const writes: string[] = [];
	let component: any;
	const ui = {
		custom: (factory: any) => new Promise<void>((resolve) => {
			component = factory({ terminal: { rows: 24, columns: 80, write: (data: string) => writes.push(data) },
				requestRender() {}, ...tui }, { fg: (_color: string, text: string) => text,
				bold: (text: string) => text }, null, resolve);
			component.render(64);
		}),
	};
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	component.handleInput("\x1b");
	await preview;
	return writes;
}

test("showTextPreview restores multiplexed fullscreen hover tracking on close", async () => {
	const previousTmux = process.env.TMUX;
	process.env.TMUX = "test";
	try {
		assert.deepEqual(await hoverWrites({ mode: "fullscreen", mouseEnabled: true }),
			["\x1b[?1003h", "\x1b[?1003l"]);
		assert.deepEqual(await hoverWrites({ mode: "fullscreen", mouseEnabled: false }), [],
			"a host that disabled mouse tracking keeps it disabled");
		assert.deepEqual(await hoverWrites({ mode: "regular", mouseEnabled: true }), [],
			"the regular screen never enables mouse reporting");
	} finally {
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
	}
});

test("context breakdown follows context_edit omissions and replacements, not raw entries", () => {
	const omitted = "O".repeat(400);
	const beforeEdit = "B".repeat(200);
	const raw = [
		{ type: "message", message: { role: "user", content: "kept question", timestamp: 0 } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: omitted }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "bash", content: omitted, timestamp: 0 } },
		{ type: "message", message: { role: "user", content: beforeEdit, timestamp: 0 } },
	];
	const ctx = {
		getSystemPromptOptions: () => ({ selectedTools: [], contextFiles: [], skills: [] }),
		getSystemPrompt: () => "",
		sessionManager: {
			// The raw compaction-aware branch still holds the abandoned attempt.
			buildContextEntries: () => raw,
			// Pi omits that attempt and swaps one message before the provider sees anything.
			buildSessionProjection: () => ({
				entries: [
					{ sourceEntry: raw[0], messages: [raw[0].message] },
					{ sourceEntry: raw[1], messages: [] },
					{ sourceEntry: raw[2], messages: [] },
					{ sourceEntry: raw[3], messages: [{ ...raw[3].message, content: "replacement text" }] },
					{ sourceEntry: { type: "context_edit", targetId: "4", replacement: { content: "replacement text" } }, messages: [] },
				],
				messages: [],
			}),
		},
	} as any;
	const breakdown = collectContextBreakdown(ctx, []);
	assert.equal(breakdown.items.toolResults.length, 0, "an omitted attempt is not live context");
	assert.equal(breakdown.parts.find((part) => part.label === "Tool results")?.tokens, 0);
	const contents = breakdown.items.contextFiles.map((item) => item.content);
	assert.ok(contents.includes("kept question"));
	assert.ok(contents.includes("replacement text"), "the replacement is what the model receives");
	assert.ok(!contents.some((content) => content.includes(omitted)), "omitted content is not counted or previewed");
	assert.ok(!contents.some((content) => content.includes(beforeEdit)), "replaced content is not counted or previewed");
});

test("context breakdown keeps !! bash output out of tool results", () => {
	const visible = "v".repeat(40);
	const hidden = "h".repeat(400);
	const ctx = {
		getSystemPromptOptions: () => ({ selectedTools: [], contextFiles: [], skills: [] }),
		getSystemPrompt: () => "",
		sessionManager: {
			buildSessionProjection: () => projectionOf([
				{ type: "message", message: { role: "bashExecution", command: "echo visible", output: visible, excludeFromContext: false, timestamp: 0 } },
				{ type: "message", message: { role: "bashExecution", command: "cat secret", output: hidden, excludeFromContext: true, timestamp: 0 } },
			]),
		},
	} as any;
	const breakdown = collectContextBreakdown(ctx, []);
	assert.deepEqual(
		breakdown.items.toolResults.map((item) => item.label),
		["Bash: echo visible"],
		"only context-visible bash output is listed",
	);
	assert.equal(
		breakdown.parts.find((part) => part.label === "Tool results")?.tokens,
		Math.ceil(("echo visible".length + visible.length) / 4),
		"excluded output contributes no tokens",
	);
});

test("overlays act only on normalized mouse events, not raw SGR bytes in handleInput", async () => {
	let closed = false;
	let closedByRawPacket = true;
	const ui = {
		custom: async (factory: any) => new Promise<void>((resolve) => {
			const component = factory(
				{ terminal: { rows: 24, columns: 80 }, requestRender() {} },
				{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
				null,
				() => { closed = true; resolve(); },
			);
			component.render(64);
			// Pi enables mouse reporting only in the fullscreen TUI and consumes SGR packets there
			// before any component sees them, so a raw packet never arrives as keyboard input.
			component.handleInput("\x1b[<0;67;3M");
			closedByRawPacket = closed;
			component.handleInput("\x1b");
		}),
	};
	await showTextPreview({ ui } as any, "Output", "hello");
	assert.equal(closedByRawPacket, false, "a raw escape packet is not a click on [esc]");
	assert.equal(closed, true, "esc still closes the preview");
	assert.equal(hasActiveTextPreview(), false);
});

test("image blocks stay out of /context leaves and previews, replaced by their size", () => {
	// 1_398_104 base64 characters decode to 1_048_576 bytes.
	const data = "A".repeat(1_398_104);
	const ctx = {
		getSystemPromptOptions: () => ({ selectedTools: [] }),
		getSystemPrompt: () => "",
		sessionManager: {
			buildSessionProjection: () => projectionOf([
				{ type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "image", mimeType: "image/png", data }], timestamp: 0 } },
				{ type: "custom_message", customType: "attachment", content: [{ type: "image", mimeType: "image/jpeg", data }, { type: "text", text: "caption" }] },
			]),
		},
	} as any;
	const breakdown = collectContextBreakdown(ctx, []);
	const result = breakdown.items.toolResults[0].content;
	assert.doesNotMatch(result, /A{100}/, "the base64 payload is not kept in the leaf");
	assert.match(result, /\[image image\/png, 1\.0 MB\]/);
	const attachment = breakdown.items.contextFiles.find((item) => item.label === "Custom: attachment")!;
	assert.match(attachment.content, /\[image image\/jpeg, 1\.0 MB\]/);
	assert.match(attachment.content, /caption/, "text blocks next to an image are untouched");
	const previews = breakdown.previews.toolResults() + breakdown.previews.contextFiles();
	assert.doesNotMatch(previews, /A{100}/);
	assert.match(previews, /\[image image\/png, 1\.0 MB\]/);
});
