import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
	type ToolInfo,
	type Theme,
	estimateTokens,
	formatSkillsForPrompt,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { Key, Markdown, matchesKey, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { padLine, wrapRawLines } from "./format.ts";

export type ContextPart = {
	label: string;
	tokens: number;
	color: "accent" | "success" | "warning" | "customMessageLabel" | "muted" | "dim" | "error";
};

type PreviewKey =
	| "systemPrompt"
	| "memoryFiles"
	| "skills"
	| "tools"
	| "toolResults"
	| "contextFiles";

export type ContextItem = {
 label: string;
 tokens: number;
 content: string;
 source: string;
 // Structured leaves stay raw; document leaves offer Markdown with an optional raw view.
 raw?: boolean;
};

type ContextPreview = {
	key: PreviewKey;
	label: string;
};

// Preserve Markdown escapes; only raw mode doubles source backslashes for reversibility.
function normalizePreviewText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "  ")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, escapeRawControls);
}

// Raw leaves retain their source content; escape controls (and backslashes) only for safe, reversible display.
function escapeRawControls(text: string): string {
	return text.replace(/[\\\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, (character) => {
		if (character === "\\") return "\\\\";
		if (character === "\t") return "\\t";
		if (character === "\r") return "\\r";
		return `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`;
	});
}

function escapeSingleLineLabel(text: string): string {
	return escapeRawControls(text).replace(/\n/g, "\\n");
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

const contextOverlayOptions = { anchor: "center" as const, width: 80, minWidth: 44, maxHeight: "90%" as const, margin: 1 };

function contextDialogHeight(rows: number): number {
	return Math.max(1, Math.min(30, Math.floor(rows * 0.9), rows - 2));
}

// Below a usable table size, retain keyboard dismissal without overflowing the terminal.
function compactDialog(width: number, height: number, title: string, theme: Pick<Theme, "fg">): string[] | undefined {
	if (width >= 38 && height >= 10) return undefined;
	return Array.from({ length: height }, (_, row) => padLine(theme.fg("dim", row === 0 ? `${title} · [esc]` : ""), width));
}

let activeContextOverlays = 0;

/** Number of open context dialogs (including text previews). */
export function hasActiveTextPreview(): boolean {
	return activeContextOverlays > 0;
}

/**
 * Fullscreen enables 1003 (hover) normally but only 1002 inside multiplexers, where the renderer
 * deliberately avoids all-motion reports. While one of these dialogs is open, upgrade to 1003 so
 * hover keeps working in tmux/zellij/screen, then restore the renderer's own mode on close.
 *
 * `mouseEnabled` is the renderer's private `mouse: false` flag and not part of the public `TUI`
 * interface, so it is read defensively: if pi-tui renames it we skip the upgrade rather than switch
 * mouse tracking on for a host that turned it off.
 */
function enableOverlayHover(tui: TUI): () => void {
	const term = process.env.TERM?.toLowerCase() ?? "";
	const multiplexed = process.env.TMUX !== undefined || process.env.ZELLIJ !== undefined ||
		process.env.STY !== undefined || term.startsWith("tmux") || term.startsWith("screen");
	const mouseEnabled = (tui as { mouseEnabled?: unknown }).mouseEnabled === true;
	if (tui.mode !== "fullscreen" || !multiplexed || !mouseEnabled) return () => {};
	tui.terminal.write("\x1b[?1003h");
	return () => tui.terminal.write("\x1b[?1003l");
}

export async function showTextPreview(
	ctx: Pick<ExtensionCommandContext, "ui">,
	title: string,
	rawContent: string,
 raw = false,
): Promise<void> {
	const rawDisplay = escapeRawControls(rawContent);
	activeContextOverlays++;
	let restoreHover = () => {};
	try {
		await ctx.ui.custom(
			(tui, theme, _keybindings, done) => {
				restoreHover = enableOverlayHover(tui);
				let showingRaw = raw;
				let scrollOffset = 0;
                let pendingG = false;
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
				const markdownView = raw ? undefined : new Markdown(normalizePreviewText(rawContent), 0, 0, getMarkdownTheme());

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
						markdownView?.invalidate();
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "h") {
							done(undefined);
							return;
						}
						if (data === "g") { if (pendingG) scrollTo(0); pendingG = !pendingG; return; }
                        pendingG = false;
						if (data === "r" && markdownView) {
							showingRaw = !showingRaw;
							scrollOffset = 0;
							scrollbarDragOffset = null;
							scrollbarHitbox = undefined;
							tui.requestRender();
							return;
						}
                        if (matchesKey(data, Key.up) || data === "k") scrollTo(scrollOffset - 1);
						else if (matchesKey(data, Key.down) || data === "j") scrollTo(scrollOffset + 1);
                        else if (data === "G") scrollTo(totalLines - pageSize);
                        else if (matchesKey(data, Key.ctrl("u"))) scrollTo(scrollOffset - Math.max(1, Math.floor(pageSize / 2)));
                        else if (matchesKey(data, Key.ctrl("d"))) scrollTo(scrollOffset + Math.max(1, Math.floor(pageSize / 2)));
						else if (matchesKey(data, "pageUp")) scrollTo(scrollOffset - pageSize);
						else if (matchesKey(data, "pageDown")) scrollTo(scrollOffset + pageSize);
						else if (matchesKey(data, Key.home)) scrollTo(0);
						else if (matchesKey(data, Key.end)) scrollTo(totalLines - pageSize);
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
						const availableHeight = Math.max(1, terminalHeight - 2);
						const viewportHeight = contextDialogHeight(terminalHeight);
						const displayTitle = escapeSingleLineLabel(showingRaw ? `controls escaped · ${title}` : title);
						const compact = compactDialog(width, viewportHeight, displayTitle, theme);
						if (compact) { escHitbox = undefined; scrollbarHitbox = undefined; return compact; }
						pageSize = Math.max(1, viewportHeight - 6);
						const wrapped = showingRaw ? wrapRawLines(rawDisplay, bodyWidth) : markdownView!.render(bodyWidth);
						totalLines = wrapped.length;
						scrollOffset = Math.min(scrollOffset, Math.max(0, totalLines - pageSize));
						// Mirror TUI resolveOverlayLayout for a centered overlay with margin 1.
						const overlayTop = 1 + Math.floor((availableHeight - viewportHeight) / 2);
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
						const toggle = markdownView ? `[r] ${showingRaw ? "markdown" : "raw"} · ` : "";
						const status = `${toggle}${start}-${end} / ${totalLines} lines · ↑↓ PgUp/PgDn Home/End · [esc] close`;

						return [
							border(`╭${"─".repeat(inner)}╮`),
							`${border("│")}${padLine(` ${theme.bold(theme.fg("accent", displayTitle))}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
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
				overlayOptions: contextOverlayOptions,
			},
		);
	} finally {
		restoreHover();
		activeContextOverlays--;
	}
}

const tokenEstimate = (value: unknown): number => {
	if (!value) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(0, Math.ceil(text.length / 4));
};

/** 只统计确实嵌进 system prompt 的片段，避免源文件预览把占用加两遍。 */
function embeddedTokens(prompt: string, chunk: string): number {
	if (!chunk || !prompt.includes(chunk)) return 0;
	return tokenEstimate(chunk);
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

export function formatTokens(tokens: number): string {
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

type ContextBreakdown = {
	parts: ContextPart[];
	/** Aggregate preview text per category, assembled only when it is actually requested. */
	previews: Record<PreviewKey, () => string>;
 items: Record<PreviewKey, ContextItem[]>;
};

/** Base64 image data is megabytes of payload the model sees as one block; show its size instead. */
function imagePlaceholder(block: { mimeType?: string; data?: string }): string {
	const data = typeof block.data === "string" ? block.data : "";
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const bytes = Math.max(0, Math.floor((data.length * 3) / 4) - padding);
	const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `[image ${block.mimeType ?? "unknown"}, ${size}]`;
}

/** Keep text blocks intact, replace image blocks with their placeholder. */
function compactContent(value: unknown): unknown {
	if (!Array.isArray(value)) return value;
	return value.map((block) =>
		typeof block === "object" && block !== null && (block as { type?: unknown }).type === "image"
			? imagePlaceholder(block as { mimeType?: string; data?: string })
			: block,
	);
}

function previewValue(value: unknown): string {
	const content = compactContent(value);
	if (typeof content === "string") return content;
	return `\`\`\`json\n${JSON.stringify(content, null, 2)}\n\`\`\``;
}

/** Defer joining a category's preview sections until something asks for them. */
function joinedPreview(parts: Array<() => string>, empty: string): () => string {
	return () => parts.map((part) => part()).join("\n\n") || empty;
}

function leafValue(value: unknown): string {
	const content = compactContent(value);
	return typeof content === "string" ? content : JSON.stringify(content, null, 2) ?? String(content);
}

/** estimateTokens() only knows Pi's own message shapes; locally injected custom content can be structured. */
function messageTokens(message: Parameters<typeof estimateTokens>[0]): number {
	const content = (message as { content?: unknown }).content;
	const structured = content !== undefined && typeof content !== "string" && !Array.isArray(content);
	return structured ? tokenEstimate(content) : estimateTokens(message);
}

/** Name a projected message after the raw entry that owns it; projection drops the entry typing. */
function projectedEntryLabel(sourceEntry: SessionEntry, role: string): string {
	if (sourceEntry.type === "compaction") return "compaction";
	if (sourceEntry.type === "branch_summary") return "branch_summary";
	if (sourceEntry.type === "custom_message") return `Custom: ${sourceEntry.customType}`;
	return role;
}

/** 按真实请求的 systemPrompt、tools、messages 三部分同步组装计数与预览。 */
export function collectContextBreakdown(
	ctx: ExtensionCommandContext,
	allTools: ToolInfo[],
): ContextBreakdown {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as BuildSystemPromptOptions;
	const systemPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
	const selectedTools = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
	const toolDefinitionPreview: Array<() => string> = [];
	const toolResultPreview: Array<() => string> = [];
	const contextPreview: Array<() => string> = [];
	let toolDefinitionTokens = 0;
	let toolResultTokens = 0;
	let contextTokens = 0;

	const items: Record<PreviewKey, ContextItem[]> = { systemPrompt: [], memoryFiles: [], skills: [], tools: [], toolResults: [], contextFiles: [] };
 const memoryPreview: Array<() => string> = [];
	let memoryTokens = 0;
	for (const file of options.contextFiles ?? []) {
		const tokens = embeddedTokens(systemPrompt, file.content);
        memoryTokens += tokens;
        items.memoryFiles.push({ label: file.path, tokens, content: file.content, source: "Embedded memory file", raw: false });
		memoryPreview.push(() => `## ${file.path}\n\n${previewValue(file.content)}`);
	}

	const skillsText = formatSkillsForPrompt(options.skills ?? []).trim();
	const skillsTokens = embeddedTokens(systemPrompt, skillsText);
 for (const skill of options.skills ?? []) {
   const advertisement = formatSkillsForPrompt([skill]).match(/<skill>[\s\S]*?<\/skill>/)?.[0];
   if (!advertisement || !skillsText.includes(advertisement)) continue;
   items.skills.push({ label: skill.name, tokens: embeddedTokens(systemPrompt, advertisement), content: advertisement, source: "Prompt advertisement", raw: true });
   if (skill.filePath) {
     try { items.skills.push({ label: `${skill.name} · SKILL.md`, tokens: 0, content: readFileSync(skill.filePath, "utf8"), source: "On-disk SKILL.md · NOT LOADED", raw: false }); } catch { /* A missing local source is not part of the prompt. */ }
   }
 }
 const skillWrapperTokens = Math.max(0, skillsTokens - items.skills.reduce((sum, item) => sum + item.tokens, 0));
 if (skillWrapperTokens > 0) items.skills.push({ label: "Skill prompt wrapper · unattributed", tokens: skillWrapperTokens, content: skillsText, source: "Complete skill prompt (includes advertisements); wrapper estimate", raw: true });

	for (const tool of allTools) {
		if (!selectedTools.has(tool.name)) continue;
		const definition = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		const tokens = tokenEstimate(definition);
        toolDefinitionTokens += tokens;
        items.tools.push({ label: tool.name, tokens, content: JSON.stringify(definition, null, 2), source: "Local registered tool schema · estimate", raw: true });
		toolDefinitionPreview.push(() => `## Definition: ${tool.name}\n\n${previewValue(definition)}`);
	}

	// The provider receives the projection, not the raw branch: a context_edit can omit an entry
	// (replacement: null) or swap its content, and only the newest compaction is a live checkpoint.
	for (const projected of ctx.sessionManager.buildSessionProjection().entries) {
		if (projected.messages.length === 0) continue;
		const source = projected.sourceEntry;
		const entryHeading = source.type === "compaction" ? "Compaction" : source.type === "branch_summary" ? "Branch summary" : undefined;
		for (const message of projected.messages) {
			const label = projectedEntryLabel(source, message.role);
			const heading = entryHeading ?? label;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") {
						const tokens = tokenEstimate(block.name) + tokenEstimate(block.arguments);
                        contextTokens += tokens;
                        items.contextFiles.push({ label: `Assistant tool call: ${block.name}`, tokens, content: leafValue(block.arguments), source: "Local session entry · provider payload unavailable", raw: true });
						contextPreview.push(
							() => `## Assistant tool call: ${block.name}\n\n${previewValue(block.arguments)}`,
						);
					} else if (block.type === "text") {
						const tokens = tokenEstimate(block.text);
                        contextTokens += tokens;
                        items.contextFiles.push({ label: "Assistant", tokens, content: block.text, source: "Local session entry · provider payload unavailable", raw: false });
						contextPreview.push(() => `## Assistant\n\n${block.text}`);
					} else if (block.type === "thinking") {
						const tokens = tokenEstimate(block.thinking);
                        contextTokens += tokens;
                        items.contextFiles.push({ label: "Assistant thinking", tokens, content: block.thinking, source: "Local session entry · provider payload unavailable", raw: false });
						contextPreview.push(() => `## Assistant thinking\n\n${block.thinking}`);
					}
				}
			} else if (message.role === "toolResult") {
				const tokens = estimateTokens(message);
                toolResultTokens += tokens;
                items.toolResults.push({ label: `Result: ${message.toolName}`, tokens, content: leafValue(message.content), source: "Local session entry · provider payload unavailable", raw: true });
				toolResultPreview.push(
					() => `## Result: ${message.toolName}\n\n${previewValue(message.content)}`,
				);
			} else if (message.role === "bashExecution") {
				// convertToLlm() drops `!!` executions before the request; they are not context.
				if (message.excludeFromContext) continue;
                const tokens = estimateTokens(message);
				toolResultTokens += tokens;
                items.toolResults.push({ label: `Bash: ${message.command}`, tokens, content: leafValue(message.output), source: "Local session entry · provider payload unavailable", raw: true });
				toolResultPreview.push(
					() => `## Bash\n\nCommand:\n\n${previewValue(message.command)}\n\nOutput:\n\n${previewValue(message.output)}`,
				);
			} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
				const tokens = estimateTokens(message);
                contextTokens += tokens;
                items.contextFiles.push({ label, tokens, content: message.summary, source: "Local session entry · provider payload unavailable", raw: false });
				contextPreview.push(() => `## ${heading}\n\n${message.summary}`);
			} else {
				const tokens = messageTokens(message);
                contextTokens += tokens;
                items.contextFiles.push({ label, tokens, content: leafValue(message.content), source: "Local session entry · provider payload unavailable", raw: typeof message.content !== "string" });
				contextPreview.push(() => `## ${heading}\n\n${previewValue(message.content)}`);
			}
		}
	}

	const systemTokens = Math.max(0, tokenEstimate(systemPrompt) - memoryTokens - skillsTokens);
 items.systemPrompt.push({ label: "System prompt · unattributed", tokens: systemTokens, content: systemPrompt || "No system prompt.", source: "Complete local prompt (includes embedded memory and skills); residual estimate, not isolated provider payload", raw: false });
	return {
        items,
		parts: [
			{ label: "System prompt", tokens: systemTokens, color: "accent" },
			{ label: "Memory", tokens: memoryTokens, color: "error" },
			{ label: "Skills", tokens: skillsTokens, color: "warning" },
			{ label: "Tools definition", tokens: toolDefinitionTokens, color: "success" },
			{ label: "Tool results", tokens: toolResultTokens, color: "customMessageLabel" },
			{ label: "Context", tokens: contextTokens, color: "warning" },
		] satisfies ContextPart[],
		previews: {
			systemPrompt: () => systemPrompt || "No system prompt.",
			memoryFiles: joinedPreview(memoryPreview, "No memory files in context."),
			skills: () => skillsText || "No skills in context.",
			tools: joinedPreview(toolDefinitionPreview, "No active tool definitions."),
			toolResults: joinedPreview(toolResultPreview, "No tool results in the current context."),
			contextFiles: joinedPreview(contextPreview, "No conversation context."),
		},
	};
}

/** Reconcile per-leaf estimates to a capped category; never assign unestimated provider usage to leaves. */
export function normalizeCategoryItems(items: ContextItem[], categoryTokens: number): ContextItem[] {
 const estimated = items.reduce((sum, item) => sum + item.tokens, 0);
 const target = Math.max(0, categoryTokens);
 if (estimated <= target) return items;
 let cumulative = 0;
 let previous = 0;
 return items.map((item, index) => {
  cumulative += item.tokens;
  const next = index === items.length - 1 ? target : Math.round(cumulative / estimated * target);
  const tokens = next - previous;
  previous = next;
  return { ...item, tokens };
 });
}

/** Order entries by share of their category, largest first; original order breaks ties. */
export function sortCategoryItems(items: ContextItem[]): ContextItem[] {
 return items
  .map((item, index) => ({ item, index }))
  .sort((a, b) => b.item.tokens - a.item.tokens || a.index - b.index)
  .map(({ item }) => item);
}

/** A sequential second layer: the root overlay is never rendered or styled by this component. */
export async function showCategoryMenu(
 ctx: Pick<ExtensionCommandContext, "ui">,
 category: ContextPart,
 items: ContextItem[],
 contextWindow: number,
): Promise<ContextItem | undefined> {
 activeContextOverlays++;
 let restoreHover = () => {};
 const orderedItems = sortCategoryItems(items);
 const displayedItems = normalizeCategoryItems(orderedItems, category.tokens);
 try {
  const selected = await ctx.ui.custom((tui, theme, _keys, done) => {
   restoreHover = enableOverlayHover(tui);
   let index = 0;
   let offset = 0;
   let pageSize = 1;
   let pendingG = false;
   let hovered = -1;
   let escHovered = false;
   let hitboxes: { index: number; row: number; startCol: number; endCol: number }[] = [];
   let escHitbox: ReturnType<typeof escCloseHitbox> | undefined;
   const choose = (next: number) => {
    index = Math.max(0, Math.min(orderedItems.length - 1, next));
    if (index < offset) offset = index;
    if (index >= offset + pageSize) offset = index - pageSize + 1;
    tui.requestRender();
   };
   const mouseAt = (row: number, col: number, press: boolean) => {
    const overEsc = Boolean(escHitbox && row === escHitbox.row && col >= escHitbox.startCol && col <= escHitbox.endCol);
    const match = hitboxes.find((box) => box.row === row && col >= box.startCol && col <= box.endCol);
    if (press) {
     if (overEsc) done(undefined);
     else if (match) { choose(match.index); done(match.index); }
    } else if (escHovered !== overEsc || hovered !== (match?.index ?? -1)) {
     escHovered = overEsc;
     hovered = match?.index ?? -1;
     tui.requestRender();
    }
   };
   return {
    invalidate() {},
    handleInput(data: string) {
     if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "h" || data === "q") { done(undefined); return; }
     if (data === "g") { if (pendingG) choose(0); pendingG = !pendingG; return; }
     pendingG = false;
     if (matchesKey(data, Key.up) || data === "k") choose(index - 1);
     else if (matchesKey(data, Key.down) || data === "j") choose(index + 1);
     else if (data === "G" || matchesKey(data, Key.end)) choose(orderedItems.length - 1);
     else if (matchesKey(data, Key.home)) choose(0);
     else if (matchesKey(data, Key.ctrl("d")) || matchesKey(data, "pageDown")) choose(index + pageSize);
     else if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, "pageUp")) choose(index - pageSize);
     else if (matchesKey(data, Key.enter) || data === "l") { if (orderedItems.length) done(index); }
    },
    handleMouse(event: TuiMouseEvent) {
     if (event.type === "wheel") choose(index + Math.sign(event.wheelDelta ?? 0) * 3);
     else if (event.type === "press" || event.type === "move")
      mouseAt(event.screenY + 1, event.screenX + 1, event.type === "press" && event.button === "left");
     return { handled: true };
    },
    render(width: number) {
     const inner = Math.max(1, width - 2);
     const border = (text: string) => theme.fg("border", text);
     const terminalHeight = Math.max(1, tui.terminal.rows);
     const maxHeight = contextDialogHeight(terminalHeight);
     const compact = compactDialog(width, maxHeight, escapeSingleLineLabel(category.label), theme);
     if (compact) { hitboxes = []; escHitbox = undefined; return compact; }
     pageSize = maxHeight - 9;
     offset = Math.max(0, Math.min(offset, Math.max(0, items.length - pageSize)));
     if (index < offset) offset = index;
     if (index >= offset + pageSize) offset = index - pageSize + 1;
     const visible = displayedItems.slice(offset, offset + pageSize);
     const parent = Math.max(1, category.tokens);
     const categoryWidth = inner >= 38 ? 10 : 8;
     const categoryHeading = categoryWidth === 10 ? "% category" : "% cat.";
     const labelWidth = Math.max(1, inner - 27 - categoryWidth);
     const heading = `${" ".repeat(5 + labelWidth)}Est. tokens  % window ${categoryHeading.padStart(categoryWidth)}`;
     const rows = visible.map((item, n) => {
      const amount = `${formatTokens(item.tokens).padStart(11)}  ${`${(contextWindow > 0 ? item.tokens / contextWindow * 100 : 0).toFixed(1)}%`.padStart(8)} ${`${(item.tokens / parent * 100).toFixed(0)}%`.padStart(categoryWidth)}`;
      const label = padLine(escapeSingleLineLabel(item.label), labelWidth);
      const line = padLine(`${offset + n === index ? "› " : "  "}${theme.fg(category.color, "■")} ${label} ${amount}`, inner);
      return `${border("│")}${offset + n === index ? theme.bg("selectedBg", line) : offset + n === hovered ? theme.bg("customMessageBg", line) : line}${border("│")}`;
     });
     const escWidth = visibleWidth("[esc]");
     const percent = contextWindow > 0 ? category.tokens / contextWindow * 100 : 0;
     const barWidth = Math.max(1, inner - 2);
     const cells = Math.min(barWidth, Math.round(percent / 100 * barWidth));
     const lines = [
      border(`╭${"─".repeat(inner)}╮`),
      `${border("│")}${padLine(` ${theme.bold(theme.fg("accent", escapeSingleLineLabel(category.label)))}  ${theme.fg("muted", `${formatTokens(category.tokens)} tokens (${percent.toFixed(1)}%)`)}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
      `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
      `${border("│")}${padLine(` ${theme.fg(category.color, "█".repeat(cells))}${theme.fg("dim", "░".repeat(barWidth - cells))}`, inner)}${border("│")}`,
      `${border("│")}${" ".repeat(inner)}${border("│")}`,
      `${border("│")}${padLine(theme.fg("dim", heading), inner)}${border("│")}`,
      ...rows,
      ...Array.from({ length: pageSize - rows.length }, () => `${border("│")}${" ".repeat(inner)}${border("│")}`),
      `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
      `${border("│")}${padLine(theme.fg("dim", ` ${orderedItems.length ? `${offset + 1}-${offset + visible.length}/${orderedItems.length}` : "No items"} · ↑↓ Enter · [esc] back`), inner)}${border("│")}`,
      border(`╰${"─".repeat(inner)}╯`),
     ];
     const top = 1 + Math.floor((Math.max(1, terminalHeight - 2) - Math.min(lines.length, maxHeight)) / 2);
     const left = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
     escHitbox = escCloseHitbox({ left, top, width });
     hitboxes = visible.map((_, n) => ({ index: offset + n, row: top + 7 + n, startCol: left + 1, endCol: left + width }));
     return lines;
    },
   };
  }, { overlay: true, overlayOptions: contextOverlayOptions });
  return selected === undefined ? undefined : orderedItems[selected as number];
 } finally { restoreHover(); activeContextOverlays--; }
}

export default function contextUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show the current context-window distribution",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const tools = pi.getAllTools();
			const breakdown = collectContextBreakdown(ctx, tools);
			const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
			// System / Memory / Skills / Tools definition 为固定项，capParts 时保持原值不压缩。
			const fixedTokens = breakdown.parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
			const used = Math.max(resolveUsedTokens(usage, estimated, contextWindow), fixedTokens);
			const parts = capParts(breakdown.parts, used, 4);
			const attributed = parts.reduce((sum, part) => sum + part.tokens, 0);
			const other = Math.max(0, used - attributed);
			const free = Math.max(0, contextWindow - used);
			const allParts = [
				...parts,
				{ label: "Other", tokens: other, color: "muted" as const },
				{ label: "Free space", tokens: free, color: "dim" as const },
			];

			if (ctx.mode !== "tui") {
				const lines = allParts.map((part) => `${part.label}: ${formatTokens(part.tokens)} tokens`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const previews: ContextPreview[] = [
				{ key: "systemPrompt", label: "System prompt" },
				{ key: "memoryFiles", label: "Memory" },
				{ key: "skills", label: "Skills" },
				{ key: "tools", label: "Tools definition" },
				{ key: "toolResults", label: "Tool results" },
				{ key: "contextFiles", label: "Context" },
			];
			const previewByKey = new Map(previews.map((preview) => [preview.key, preview]));
			const visiblePreviews = previews.filter((preview) =>
				allParts.some((part) => part.label === preview.label),
			);
			let selectedPreviewIndex = 0;

			while (true) {
				activeContextOverlays++;
				let restoreHover = () => {};
				let action;
				try {
					action = await ctx.ui.custom(
						(tui, theme, _keybindings, done) => {
							restoreHover = enableOverlayHover(tui);
							let previewHitboxes: Array<{
								key: PreviewKey;
								row: number;
								startCol: number;
								endCol: number;
							}> = [];
							let escHitbox: { row: number; startCol: number; endCol: number } | undefined;
							let escHovered = false;
							let hoveredKey: PreviewKey | undefined;
							let pendingRootG = false;
							let rowOffset = 0;
							let rootPageSize = 1;
							let keepSelectionVisible = true;
							const scrollRows = (delta: number) => {
								pendingRootG = false;
								keepSelectionVisible = false;
								rowOffset = Math.max(0, Math.min(rowOffset + delta, allParts.length - rootPageSize));
								tui.requestRender();
							};

							return {
								invalidate() {},
								handleInput(data: string) {
									if (matchesKey(data, "pageDown")) { scrollRows(rootPageSize); return; }
									if (matchesKey(data, "pageUp")) { scrollRows(-rootPageSize); return; }
									keepSelectionVisible = true;
									if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q" || data === "h") {
										done(undefined);
										return;
									}
									if (data === "g") {
                                        if (pendingRootG) { selectedPreviewIndex = 0; tui.requestRender(); }
                                        pendingRootG = !pendingRootG;
                                        return;
                                    }
                                    pendingRootG = false;
                                    if (data === "G") { selectedPreviewIndex = visiblePreviews.length - 1; tui.requestRender(); return; }
                                    if (matchesKey(data, Key.ctrl("u")) || matchesKey(data, Key.ctrl("d"))) {
                                        selectedPreviewIndex = Math.max(0, Math.min(visiblePreviews.length - 1, selectedPreviewIndex + (matchesKey(data, Key.ctrl("d")) ? 3 : -3)));
                                        tui.requestRender(); return;
                                    }
                                    if ((matchesKey(data, Key.up) || data === "k") && visiblePreviews.length > 0) {
										selectedPreviewIndex =
											(selectedPreviewIndex - 1 + visiblePreviews.length) % visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if ((matchesKey(data, Key.down) || data === "j") && visiblePreviews.length > 0) {
										selectedPreviewIndex = (selectedPreviewIndex + 1) % visiblePreviews.length;
										tui.requestRender();
										return;
									}
									if (matchesKey(data, Key.enter) || data === "l") {
										done(visiblePreviews[selectedPreviewIndex]?.key);
										return;
									}
								},
								handleMouse(event: TuiMouseEvent) {
									pendingRootG = false;
									const row = event.screenY + 1;
									const col = event.screenX + 1;
									if (event.type === "wheel") { scrollRows(Math.sign(event.wheelDelta ?? 0) * 3); return { handled: true }; }
									if (event.type === "click" || event.type === "release") return { handled: true };
									const overEsc = Boolean(escHitbox && row === escHitbox.row &&
										col >= escHitbox.startCol && col <= escHitbox.endCol);
									const hitbox = previewHitboxes.find((candidate) => row === candidate.row &&
										col >= candidate.startCol && col <= candidate.endCol);
									if (overEsc !== escHovered || hitbox?.key !== hoveredKey) {
										escHovered = overEsc;
										hoveredKey = hitbox?.key;
										tui.requestRender();
									}
									if (event.type === "press" && event.button === "left") {
										if (overEsc) done(undefined);
										else if (hitbox) {
											selectedPreviewIndex = Math.max(0,
												visiblePreviews.findIndex((preview) => preview.key === hitbox.key));
											done(hitbox.key);
										}
									}
									return { handled: true };
								},
								render(width: number) {
									const inner = Math.max(1, width - 2);
									const terminalHeight = Math.max(1, tui.terminal.rows);
									const maxHeight = contextDialogHeight(terminalHeight);
									const compact = compactDialog(width, maxHeight, "Context Usage", theme);
									if (compact) { previewHitboxes = []; escHitbox = undefined; return compact; }
									const pageSize = rootPageSize = maxHeight - 9;
									rowOffset = Math.max(0, Math.min(rowOffset, allParts.length - pageSize));
									if (keepSelectionVisible) {
										if (selectedPreviewIndex < rowOffset) rowOffset = selectedPreviewIndex;
										if (selectedPreviewIndex >= rowOffset + pageSize) rowOffset = selectedPreviewIndex - pageSize + 1;
									}
									const escWidth = visibleWidth("[esc]");
									const percent = contextWindow > 0 ? (used / contextWindow) * 100 : 0;
									const title = theme.bold(theme.fg("accent", "Context Usage"));
									const subtitle = `${formatTokens(used)} / ${formatTokens(contextWindow)} tokens (${percent.toFixed(1)}%)`;
									const barWidth = Math.max(1, inner - 2);
									let remaining = barWidth;
									const segments = allParts
										.map((part, index) => {
											const cells =
												index === allParts.length - 1
													? remaining
													: Math.min(
															remaining,
															Math.round((part.tokens / Math.max(1, contextWindow)) * barWidth),
														);
											remaining -= cells;
											return theme.fg(part.color, "█".repeat(Math.max(0, cells)));
										})
										.join("");
									const labelWidth = Math.max(1, inner - 26);
									const selectedLabel = visiblePreviews[selectedPreviewIndex]?.label;
									const heading = `${" ".repeat(5 + labelWidth)}Est. tokens  % window`;
									const partRows = allParts.slice(rowOffset, rowOffset + pageSize).map((part) => {
										const pct = contextWindow > 0 ? (part.tokens / contextWindow) * 100 : 0;
										const swatch = theme.fg(part.color, "■");
										const label = padLine(part.label, labelWidth);
										const amount = `${formatTokens(part.tokens).padStart(11)}  ${`${pct.toFixed(1)}%`.padStart(8)}`;
										const selected = part.label === selectedLabel;
										const hoverLabel = visiblePreviews.find((p) => p.key === hoveredKey)?.label;
										const prefix = selected ? "› " : "  ";
										const row = padLine(`${prefix}${swatch} ${label} ${amount}`, inner);
										if (selected) return theme.bg("selectedBg", row);
										return part.label === hoverLabel ? theme.bg("customMessageBg", row) : row;
									});
									const border = (text: string) => theme.fg("border", text);
									const lines = [
										border(`╭${"─".repeat(inner)}╮`),
										`${border("│")}${padLine(` ${title}  ${theme.fg("muted", subtitle)}`, inner - escWidth)}${theme.fg(escHovered ? "text" : "muted", "[esc]")}${border("│")}`,
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(` ${segments}`, inner)}${border("│")}`,
										`${border("│")}${" ".repeat(inner)}${border("│")}`,
										`${border("│")}${padLine(theme.fg("dim", heading), inner)}${border("│")}`,
										...partRows.map((row) => `${border("│")}${row}${border("│")}`),
										...Array.from({ length: pageSize - partRows.length }, () => `${border("│")}${" ".repeat(inner)}${border("│")}`),
										`${border("├")}${border("─".repeat(inner))}${border("┤")}`,
										`${border("│")}${padLine(theme.fg("dim", " ↑↓ select · Click / Enter to preview · [esc] close"), inner)}${border("│")}`,
										border(`╰${"─".repeat(inner)}╯`),
									];

									const visibleHeight = Math.min(lines.length, maxHeight);
									const overlayTop =
										1 + Math.floor((Math.max(1, terminalHeight - 2) - visibleHeight) / 2);
									const overlayLeft = Math.floor((Math.max(1, tui.terminal.columns) - width) / 2);
									escHitbox = escCloseHitbox({ left: overlayLeft, top: overlayTop, width });
									previewHitboxes = visiblePreviews.flatMap((preview) => {
										const partIndex = allParts.findIndex((part) => part.label === preview.label);
										const line = 6 + partIndex - rowOffset;
										return partIndex >= rowOffset && partIndex < rowOffset + pageSize
											? [
													{
														key: preview.key,
														row: overlayTop + line + 1,
														startCol: overlayLeft + 1,
														endCol: overlayLeft + width,
													},
												]
											: [];
									});

									return lines;
								},
							};
						},
						{
							overlay: true,
							overlayOptions: contextOverlayOptions,
						},
					);
				} finally {
					restoreHover();
					activeContextOverlays--;
				}

				if (!action) break;
				const preview = previewByKey.get(action as PreviewKey);
                if (!preview) continue;
                const part = allParts.find((part) => part.label === preview.label)!;
                const entries = breakdown.items[preview.key];
                while (true) {
                    const item = await showCategoryMenu(ctx, part, entries, contextWindow);
                    if (!item) break;
                    await showTextPreview(ctx, `${item.source} · ${item.label}`, item.content, item.raw);
                }
			}
		},
	});
}
