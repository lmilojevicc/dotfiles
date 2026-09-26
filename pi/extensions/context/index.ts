import { type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
export { collectDetails, promptAttribution } from "./breakdown.ts";
export { default } from "./dialog.ts";
import { mouseBaseButton, parseSgrMousePacket } from "./sgr-mouse.ts";
import { padLine } from "./format.ts";

export type ContextPart = {
	label: string;
	tokens: number;
	color: "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error";
};

function normalizePreviewText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ");
}

export type DialogBounds = { left: number; top: number; width: number };

/** 1-based terminal hitbox of the [esc] close button on the dialog title row (row 2 of the box). */
export function escCloseHitbox(bounds: DialogBounds): {
	row: number;
	startCol: number;
	endCol: number;
} {
	return {
		row: bounds.top + 2,
		startCol: bounds.left + bounds.width - 5,
		endCol: bounds.left + bounds.width - 1,
	};
}

let activeContextOverlays = 0;

/** Number of open raw text previews. */
export function hasActiveTextPreview(): boolean {
	return activeContextOverlays > 0;
}

// Fullscreen uses 1003 normally, but limits multiplexers to 1002. Restore that mode on close.
function enableOverlayHover(tui: any): () => void {
	const term = process.env.TERM?.toLowerCase() ?? "";
	const multiplexed = process.env.TMUX !== undefined || process.env.ZELLIJ !== undefined ||
		process.env.STY !== undefined || term.startsWith("tmux") || term.startsWith("screen");
	if (tui.mode !== "fullscreen" || !multiplexed || !tui.mouseEnabled) return () => {};
	tui.terminal.write("\x1b[?1003h");
	return () => tui.terminal.write("\x1b[?1003l");
}

export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string,
): Promise<void> {
	const content = normalizePreviewText(rawContent);
	activeContextOverlays++;
	let restoreHover = () => {};
	try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				restoreHover = enableOverlayHover(tui);
				let scrollOffset = 0;
				let pageSize = 1;
				let totalLines = 1;
				let escHovered = false;
				let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
				let scrollbarHitbox:
					| {
							col: number;
							startRow: number;
							endRow: number;
							thumbStart: number;
							thumbSize: number;
							maxOffset: number;
					  }
					| undefined;
				let scrollbarDragOffset: number | null = null;
				let renderedWidth = 0;
				let wrapped: string[] = [];
				const rawLines = content.split("\n");
				const renderRaw = (width: number): string[] => {
					if (width === renderedWidth) return wrapped;
					renderedWidth = width;
					wrapped = rawLines.flatMap((line) => {
						if (!line) return [""];
						const rows: string[] = [];
						let remaining = line;
						while (remaining) {
							let take = 0;
							while (take < remaining.length && visibleWidth(remaining.slice(0, take + 1)) <= width) take++;
							if (!take) take = 1;
							rows.push(remaining.slice(0, take));
							remaining = remaining.slice(take);
						}
						return rows;
					});
					return wrapped;
				};

				const scrollTo = (nextOffset: number): void => {
					const next = Math.max(0, Math.min(nextOffset, Math.max(0, totalLines - pageSize)));
					if (next === scrollOffset) return;
					scrollOffset = next;
					tui.requestRender();
				};

				const setEscHovered = (hovered: boolean): void => {
					if (hovered === escHovered) return;
					escHovered = hovered;
					tui.requestRender();
				};

				const dragScrollbarTo = (mouseRow: number): void => {
					if (!scrollbarHitbox || scrollbarDragOffset === null) return;
					const trackSize = scrollbarHitbox.endRow - scrollbarHitbox.startRow + 1;
					const maxThumbStart = Math.max(0, trackSize - scrollbarHitbox.thumbSize);
					const thumbStart = Math.max(
						0,
						Math.min(mouseRow - scrollbarHitbox.startRow - scrollbarDragOffset, maxThumbStart),
					);
					const nextOffset =
						maxThumbStart > 0
							? Math.round((thumbStart / maxThumbStart) * scrollbarHitbox.maxOffset)
							: 0;
					scrollTo(nextOffset);
				};

				return {
					invalidate() {
						renderedWidth = 0;
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.up) || data === "k") scrollTo(scrollOffset - 1);
						else if (matchesKey(data, Key.down) || data === "j") scrollTo(scrollOffset + 1);
						else if (data === "q" || data === "h" || matchesKey(data, Key.left)) done(undefined);
						else if (data === "G") scrollTo(totalLines - pageSize);
						else if (data === "g" || data === "gg") scrollTo(0);
						else if (matchesKey(data, Key.ctrl("d"))) scrollTo(scrollOffset + Math.max(1, Math.floor(pageSize / 2)));
						else if (matchesKey(data, Key.ctrl("u"))) scrollTo(scrollOffset - Math.max(1, Math.floor(pageSize / 2)));
						else if (matchesKey(data, "pageUp")) scrollTo(scrollOffset - pageSize);
						else if (matchesKey(data, "pageDown")) scrollTo(scrollOffset + pageSize);
						else if (matchesKey(data, Key.home)) scrollTo(0);
						else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
						else {
							const mouse = parseSgrMousePacket(data);
							if (!mouse) return;
							if (mouse.final === "m") {
								scrollbarDragOffset = null;
								return;
							}
							const overEsc = Boolean(
								escHitbox &&
									mouse.row === escHitbox.row &&
									mouse.col >= escHitbox.startCol &&
									mouse.col <= escHitbox.endCol,
							);
							setEscHovered(overEsc);
							const button = mouseBaseButton(mouse.code);
							const motion = (mouse.code & 32) !== 0;
							if (button === 0 && !motion) {
								if (overEsc) {
									done(undefined);
									return;
								}
								if (
									scrollbarHitbox &&
									mouse.col === scrollbarHitbox.col &&
									mouse.row >= scrollbarHitbox.startRow &&
									mouse.row <= scrollbarHitbox.endRow
								) {
									const trackRow = mouse.row - scrollbarHitbox.startRow;
									const inThumb =
										trackRow >= scrollbarHitbox.thumbStart &&
										trackRow < scrollbarHitbox.thumbStart + scrollbarHitbox.thumbSize;
									scrollbarDragOffset = inThumb
										? trackRow - scrollbarHitbox.thumbStart
										: Math.floor(scrollbarHitbox.thumbSize / 2);
									dragScrollbarTo(mouse.row);
									return;
								}
							}
							if (motion && scrollbarDragOffset !== null) {
								dragScrollbarTo(mouse.row);
								return;
							}
							if (button === 64) scrollTo(scrollOffset - 3);
							else if (button === 65) scrollTo(scrollOffset + 3);
						}
					},

					handleMouse(event: TuiMouseEvent) {
						const row = event.screenY + 1;
						const col = event.screenX + 1;
						if (event.type === "release") {
							scrollbarDragOffset = null;
							return { handled: true };
						}
						if (event.type === "wheel") {
							scrollTo(scrollOffset + Math.sign(event.wheelDelta ?? 0) * 3);
							return { handled: true };
						}
						if (event.type === "click") return { handled: true }; // Press already acted.
						const overEsc = Boolean(escHitbox && row === escHitbox.row &&
							col >= escHitbox.startCol && col <= escHitbox.endCol);
						setEscHovered(overEsc);
						if (event.type === "drag" && scrollbarDragOffset !== null) {
							dragScrollbarTo(row);
							return { handled: true };
						}
						if (event.type === "press" && event.button === "left") {
							if (overEsc) {
								done(undefined);
								return { handled: true };
							}
							if (scrollbarHitbox && col === scrollbarHitbox.col &&
								row >= scrollbarHitbox.startRow && row <= scrollbarHitbox.endRow) {
								const trackRow = row - scrollbarHitbox.startRow;
								const inThumb = trackRow >= scrollbarHitbox.thumbStart &&
									trackRow < scrollbarHitbox.thumbStart + scrollbarHitbox.thumbSize;
								scrollbarDragOffset = inThumb ? trackRow - scrollbarHitbox.thumbStart :
									Math.floor(scrollbarHitbox.thumbSize / 2);
								dragScrollbarTo(row);
								return { handled: true, capture: true };
							}
						}
						return { handled: true };
					},

					render(width: number) {
						const inner = Math.max(1, width - 2);
						const escWidth = visibleWidth("[esc]");
						const bodyInner = Math.max(1, inner - 1);
						const bodyWidth = Math.max(1, bodyInner - 1);
						const terminalHeight = Math.max(1, tui.terminal.rows);
						const availableHeight = Math.max(1, terminalHeight - 4);
						const viewportHeight = Math.min(
							30,
							Math.max(1, Math.floor(terminalHeight * 0.8)),
							availableHeight,
						);
						pageSize = Math.max(1, viewportHeight - 6);
						const wrapped = renderRaw(bodyWidth);
						totalLines = wrapped.length;
						scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
						// Centered overlay with margin 2: mirror TUI resolveOverlayLayout for anchor "center".
						const overlayTop = 2 + Math.floor((availableHeight - viewportHeight) / 2);
						const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
						escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
						const visible = wrapped.slice(scrollOffset, scrollOffset + pageSize);
						const border = (text: string) => theme.fg("border", text);
						const scrollable = totalLines > pageSize;
						const thumbSize = scrollable
							? Math.max(1, Math.floor((pageSize * pageSize) / totalLines))
							: 0;
						const maxScrollOffset = Math.max(0, totalLines - pageSize);
						const thumbStart =
							scrollable && maxScrollOffset > 0
								? Math.round((scrollOffset / maxScrollOffset) * (pageSize - thumbSize))
								: 0;
						scrollbarHitbox = scrollable
							? {
									col: overlayLeft + width - 1,
									startRow: overlayTop + 4,
									endRow: overlayTop + 3 + pageSize,
									thumbStart,
									thumbSize,
									maxOffset: maxScrollOffset,
								}
							: undefined;
						const scrollbar = (row: number): string => {
							if (!scrollable) return " ";
							const inThumb = row >= thumbStart && row < thumbStart + thumbSize;
							return theme.fg(inThumb ? "accent" : "borderMuted", inThumb ? "█" : "│");
						};
						const bodyRows = Array.from({ length: pageSize }, (_, row) => {
							const line = visible[row] ?? "";
							return `${border("│")}${padLine(` ${line}`, bodyInner)}${scrollbar(row)}${border("│")}`;
						});
						const start = totalLines === 0 ? 0 : scrollOffset + 1;
						const end = Math.min(totalLines, scrollOffset + pageSize);
						const status = `${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · [esc] close`;

						return [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							...bodyRows,
							`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
							`${border("│")}${padLine(theme.fg("dim", ` ${status}`), inner)}${border("│")}`,
							border(`╰${"─".repeat(inner)}╯`),
						];
					},
				};
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "85%",
					minWidth: 50,
					maxHeight: "80%",
					margin: 2,
				},
			},
		);
	} finally {
		restoreHover();
		activeContextOverlays--;
	}
}

export function capParts(parts: ContextPart[], target: number, fixedPrefix = 0): ContextPart[] {
	const fixed = parts.slice(0, fixedPrefix);
	const variable = parts.slice(fixedPrefix);
	const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
	const variableTarget = Math.max(0, target - fixedTokens);
	const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
	if (estimated <= variableTarget || estimated === 0) return parts;
	if (variableTarget === 0) {
		return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];
	}

	let previous = 0;
	let cumulative = 0;
	const capped = variable.map((part, index) => {
		cumulative += part.tokens;
		const next =
			index === variable.length - 1
				? variableTarget
				: Math.round((cumulative / estimated) * variableTarget);
		const tokens = next - previous;
		previous = next;
		return { ...part, tokens };
	});
	return [...fixed, ...capped];
}

export function formatTokens(tokens: number | null): string {
	if (tokens === null) return "n/a";
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

export function resolveUsedTokens(
	usage: { tokens: number | null; percent: number | null } | undefined,
	estimated: number,
	contextWindow: number,
): number {
	const reported = usage?.tokens;
	const fromPercent =
		usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0
			? Math.round((usage.percent / 100) * contextWindow)
			: undefined;
	let resolved = reported ?? fromPercent ?? estimated;
	if (reported !== null && reported !== undefined && fromPercent !== undefined) {
		// 某些 Provider 会返回异常 totalTokens；百分比与底部状态栏不一致时优先采用百分比。
		const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
		if (Math.abs(reported - fromPercent) > tolerance) resolved = fromPercent;
	}
	// tokens 与 percent 可能同时源自异常 usage；数量级明显偏小时回退到实际内容估算。
	if (estimated > 0 && resolved < estimated * 0.25) return estimated;
	return resolved;
}
