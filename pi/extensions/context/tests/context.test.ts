// escCloseHitbox 的契约：
// [esc] 按钮位于弹框标题行（box 第 2 行）右端，5 列宽；
// bounds 为 0-based 的弹框起点（left/top）+ 宽度。
import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import contextUsageExtension, {
	capParts,
	escCloseHitbox,
	hasActiveTextPreview,
	resolveUsedTokens,
	showTextPreview,
} from "../index.ts";

initTheme("dark");

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
	// 80×24、64 列居中、margin 2 → [esc] 命中 row=4, col=67..71。
	ui.component.handleInput(`\x1b[<35;67;4M`);
	ui.component.render(64);
	assert.equal(escColor, "text", "[esc] hover switches to text color");
	ui.component.handleInput(`\x1b[<0;67;4M`);
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview scrollbar supports press and drag", async () => {
	const ui = textPreviewHarness();
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const preview = showTextPreview({ ui } as any, "Output", content);
	const initial = ui.component.render(64).join("\n");
	assert.match(initial, /1-13 \/ 100 lines/);
	// scrollbar col=71，body track row=6..18；从顶部 thumb 拖到底部。
	ui.component.handleInput(`\x1b[<0;71;6M`);
	ui.component.handleInput(`\x1b[<32;71;18M`);
	ui.component.handleInput(`\x1b[<0;71;18m`);
	const dragged = ui.component.render(64).join("\n");
	assert.match(dragged, /88-100 \/ 100 lines/);
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
		sessionManager: { buildContextEntries: () => [] },
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
	// First row in the scrollable category list, then its first detail row.
	send(35, 20, 5);
	assert.equal((components[0].render(76).join("\n")).includes("{hover esc}"), false);
	send(0, 20, 5);
	send(0, 20, 5, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(components.length, 2, "category press opens a detail list");
	send(0, 20, 5);
	send(0, 20, 5, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(components.length, 3, "detail press opens source preview");
	const preview = components[2];
	assert.match(preview.render(68).join("\n"), /1-13 \/ 102 lines/);
	const top = tui.viewportTop;
	send(65, 25, 10); // wheel down inside preview, not transcript
	assert.match(preview.render(68).join("\n"), /4-16 \/ 102 lines/);
	assert.equal(tui.viewportTop, top);
	// Preview scrollbar: overlay left 6, track column 73, rows 6..18.
	send(0, 73, 6);
	assert.ok(tui.mouseCapture, "scrollbar press captures subsequent drag");
	send(32, 2, 18); // drag outside overlay must still reach captured component
	send(0, 2, 18, true);
	assert.equal(tui.mouseCapture, undefined);
	assert.match(preview.render(68).join("\n"), /90-102 \/ 102 lines/);
	send(35, 69, 4);
	assert.match(preview.render(68).join("\n"), /\{hover esc\}/);
	send(0, 69, 4);
	send(0, 69, 4, true);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(components.length, 4, "preview esc returns to detail list");
	const main = components[3];
	tui.handleTerminalInput("\x1b[B"); // keyboard navigation still works
	tui.renderNow();
	assert.match(main.render(76).join("\n"), /System prompt/);
	tui.handleTerminalInput("\x1b"); // Back to category list.
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(components.length, 5);
	tui.handleTerminalInput("q");
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
	assert.match(ui.component.render(64).join("\n"), /4-16 \/ 100 lines/);
	assert.deepEqual(mouse("press", 70, 5), { handled: true, capture: true });
	mouse("drag", 0, 17);
	mouse("release", 0, 17);
	assert.match(ui.component.render(64).join("\n"), /88-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});

test("showTextPreview restores multiplexed fullscreen hover tracking on close", async () => {
	const previousTmux = process.env.TMUX;
	process.env.TMUX = "test";
	try {
		const writes: string[] = [];
		let component: any;
		const ui = {
			custom: (factory: any) => new Promise<void>((resolve) => {
				component = factory({ mode: "fullscreen", mouseEnabled: true,
					terminal: { rows: 24, columns: 80, write: (data: string) => writes.push(data) },
					requestRender() {} }, { fg: (_color: string, text: string) => text,
					bold: (text: string) => text }, null, resolve);
				component.render(64);
			}),
		};
		const preview = showTextPreview({ ui } as any, "Output", "hello");
		assert.deepEqual(writes, ["\x1b[?1003h"]);
		component.handleInput("\x1b");
		await preview;
		assert.deepEqual(writes, ["\x1b[?1003h", "\x1b[?1003l"]);
	} finally {
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
	}
});
