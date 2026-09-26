import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { collectDetails, type Category, type Detail } from "./breakdown.ts";
import { capParts, escCloseHitbox, formatTokens, resolveUsedTokens, showTextPreview } from "./index.ts";
import { mouseBaseButton, parseSgrMousePacket } from "./sgr-mouse.ts";
import { padLine } from "./format.ts";

type Row = { label: string; tokens: number | null; source?: string; detail?: Detail; category?: Category };
const pct = (amount: number | null, total: number): string => amount !== null && total > 0 ? `${(100 * amount / total).toFixed(1)}%` : "n/a";

/** Keep the numeric columns visible when a detail label exceeds the dialog width. */
export function formatUsageRow(row: Pick<Row, "label" | "tokens">, selected: boolean, window: number, parent: number, width: number): string {
	const tokens = formatTokens(row.tokens);
	const windowPct = pct(row.tokens, window);
	const parentPct = pct(row.tokens, parent);
	const full = `  ${tokens} est · ${windowPct} win · ${parentPct} parent`;
	const compact = `  ${tokens} · ${windowPct} · ${parentPct}`;
	const columns = full.length + 4 <= width ? full : compact;
	const prefix = ` ${selected ? "›" : " "} `;
	const labelWidth = Math.max(0, width - prefix.length - columns.length);
	const label = truncateToWidth(row.label, labelWidth, "…");
	return padLine(`${prefix}${label}${columns}`, width);
}
export function visibleRange(selected: number, offset: number, count: number, pageSize: number): number {
	const max = Math.max(0, count - pageSize);
	return Math.max(0, Math.min(max, selected < offset ? selected : selected >= offset + pageSize ? selected - pageSize + 1 : offset));
}

export default function contextUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Inspect estimated context usage and locally available sources",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const categories = collectDetails(ctx, pi.getAllTools());
			const estimated = categories.reduce((sum, category) => sum + category.tokens, 0);
			const fixed = categories.slice(0, 4).reduce((sum, category) => sum + category.tokens, 0);
			const used = Math.max(fixed, resolveUsedTokens(usage, estimated, window));
			const parts = capParts(categories, used, 4);
			const attributed = parts.reduce((sum, category) => sum + category.tokens, 0);
			const other = Math.max(0, used - attributed);
			const free = window > 0 ? Math.max(0, window - used) : null;
			const rows: Row[] = [...parts.map((part) => ({ ...part, category: categories.find((c) => c.label === part.label) })),
				{ label: "Other (unattributed)", tokens: other, source: "Reported usage not attributable to local content. No exact source available." },
				{ label: "Free space", tokens: free, source: window > 0 ? "Estimated remaining context window; no loaded payload." : "Context window unknown; free space unavailable." }];
			if (ctx.mode !== "tui") {
				ctx.ui.notify(rows.map((row) => `${row.label}: ${formatTokens(row.tokens)} estimated tokens (${pct(row.tokens, window)} window)`).join("\n"), "info");
				return;
			}
			let parent: Category | undefined;
			let selected = 0;
			let offset = 0;
			let rootSelected = 0;
			let rootOffset = 0;
			while (true) {
				const current: Row[] = parent ? parent.items.flatMap((detail) => [
					{ label: detail.label, tokens: detail.tokens, source: detail.source, detail },
					...(detail.children ?? []).map((child) => ({ label: `  ${child.label}`, tokens: child.tokens, source: child.source, detail: child })),
				]) : rows;
				let restoreHover = () => {};
				const action = await ctx.ui.custom<string | undefined>((tui, theme, _bindings, done) => {
					const term = process.env.TERM?.toLowerCase() ?? "";
					if (tui.mode === "fullscreen" && tui.mouseEnabled && (process.env.TMUX || process.env.ZELLIJ || process.env.STY || term.startsWith("tmux") || term.startsWith("screen"))) {
						tui.terminal.write("\x1b[?1003h"); restoreHover = () => tui.terminal.write("\x1b[?1003l");
					}
					let page = 1;
					let currentWidth = 0;
					let top = 0;
					let left = 0;
					let esc = { row: 0, startCol: 0, endCol: 0 };
					let hovered = -1;
					const change = (n: number) => { selected = Math.max(0, Math.min(current.length - 1, n)); offset = visibleRange(selected, offset, current.length, page); tui.requestRender(); };
					const back = () => done(parent ? "back" : "close");
					const choose = () => done(`select:${selected}`);
					const mouse = (row: number, col: number, click: boolean, wheel = 0) => {
						if (wheel) { change(selected + wheel * 3); return; }
						if (row === esc.row && col >= esc.startCol && col <= esc.endCol) { if (click) back(); return; }
						const index = row - top - 4 + offset;
						if (row >= top + 4 && row < top + 4 + page && col > left && col < left + currentWidth && index >= 0 && index < current.length) {
							if (click) { selected = index; choose(); } else if (hovered !== index) { hovered = index; tui.requestRender(); }
						}
					};
					return {
						invalidate() {},
						handleInput(data: string) {
							if (matchesKey(data, Key.escape) || data === "h" || matchesKey(data, Key.left)) back();
							else if (data === "q" || matchesKey(data, Key.ctrl("c"))) done("close");
							else if (data === "j" || matchesKey(data, Key.down)) change(selected + 1);
							else if (data === "k" || matchesKey(data, Key.up)) change(selected - 1);
							else if (data === "g" || data === "gg" || matchesKey(data, Key.home)) change(0);
							else if (data === "G" || matchesKey(data, Key.end)) change(current.length - 1);
							else if (matchesKey(data, Key.ctrl("d"))) change(selected + Math.max(1, Math.floor(page / 2)));
							else if (matchesKey(data, Key.ctrl("u"))) change(selected - Math.max(1, Math.floor(page / 2)));
							else if (matchesKey(data, "pageDown")) change(selected + page);
							else if (matchesKey(data, "pageUp")) change(selected - page);
							else if (data === "l" || matchesKey(data, Key.right) || matchesKey(data, Key.enter)) choose();
							else { const packet = parseSgrMousePacket(data); if (!packet || packet.final !== "M") return;
								const button = mouseBaseButton(packet.code);
								if (button === 64 || button === 65) mouse(packet.row, packet.col, false, button === 64 ? -1 : 1);
								else mouse(packet.row, packet.col, button === 0 && !(packet.code & 32)); }
						},
						handleMouse(event: TuiMouseEvent) {
							if (event.type === "wheel") mouse(event.screenY + 1, event.screenX + 1, false, Math.sign(event.wheelDelta ?? 0));
							else if (event.type !== "release" && event.type !== "click") mouse(event.screenY + 1, event.screenX + 1, event.type === "press" && event.button === "left");
							return { handled: true };
						},
						render(width: number) {
							currentWidth = width;
							const inner = Math.max(1, width - 2);
							const height = Math.min(Math.max(1, tui.terminal.rows - 2), Math.max(1, Math.floor(tui.terminal.rows * .9)));
							page = Math.max(1, height - 6);
							offset = visibleRange(selected, offset, current.length, page);
							top = 1 + Math.floor((Math.max(1, tui.terminal.rows - 2) - Math.min(height, page + 6)) / 2);
							left = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
							esc = escCloseHitbox({ left, top, width });
							const border = (s: string) => theme.fg("border", s);
							const title = parent ? parent.label : "Context Usage";
							const summary = `${formatTokens(used)} / ${window > 0 ? formatTokens(window) : "?"} estimated tokens (${pct(used, window)} window)`;
							const list = Array.from({ length: page }, (_, n) => {
								const index = offset + n;
								const row = current[index];
								const padded = row ? formatUsageRow(row, index === selected, window, parent?.tokens ?? (row.label === "Free space" ? 0 : used), inner) : padLine("", inner);
								return `${border("│")}${row && index === selected ? theme.bg("selectedBg", padded) : row && index === hovered ? theme.bg("customMessageBg", padded) : padded}${border("│")}`;
							});
							return [border(`╭${"─".repeat(inner)}╮`),
								`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", title))}  ${summary}`, inner - visibleWidth("[esc]"))}${theme.fg("muted", "[esc]")}${border("│")}`,
								`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
								`${border("│")}${padLine(` ${parent ? "LOCAL DETAIL — raw estimates; window%, category%" : "CATEGORIES — reconciled est; window%, used%"}`, inner)}${border("│")}`,
								...list,
								`${border("│")}${padLine(` ${offset + 1}-${Math.min(current.length, offset + page)} / ${current.length} · j/k ↑↓ gg/G ^d/u PgUp/Dn · l/Enter open · h/Esc back · q close`, inner)}${border("│")}`,
								border(`╰${"─".repeat(inner)}╯`)];
						},
					};
				}, { overlay: true, overlayOptions: { anchor: "center", width: 76, minWidth: 34, maxHeight: "90%", margin: 1 } }).finally(() => restoreHover());
				if (!action || action === "close") break;
				if (action === "back") { parent = undefined; selected = rootSelected; offset = rootOffset; continue; }
				const row = current[Number(action.slice(7))];
				if (!row) continue;
				if (row.category && row.category.items.length) { rootSelected = selected; rootOffset = offset; parent = row.category; selected = 0; offset = 0; continue; }
				await showTextPreview(ctx, row.detail?.label ?? row.label, `${row.detail?.source ?? row.source ?? "No exact attributable payload."}\n\n${row.detail?.content ?? (row.category ? "No locally attributable items in this category." : row.source ?? "")}`);
			}
		},
	});
}
