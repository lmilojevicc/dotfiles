import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type Keybinding,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import type { TaskDisplayConfig } from "../config/tasks-config.js";
import type { Task, TaskSnapshot } from "../domain/types.js";
import { taskActivity, type SessionActivity } from "../state/activity.js";
import { foregroundSnapshot, getForeground } from "../state/store.js";
import { sanitizeSearchInput, sanitizeTerminalText } from "./sanitize.js";
import { resolveTaskGlyphs } from "./task-glyphs.js";
import { sortTasks } from "./task-sort.js";
import { formatDuration, formatTokens, SPINNER_INTERVAL_MS } from "./widget.js";

export const TASKS_BOARD_OVERLAY_OPTIONS = {
	anchor: "center" as const,
	width: "95%" as const,
	minWidth: 36,
	maxHeight: "85%" as const,
	margin: 1,
};

export type BoardFilter = "All" | "In progress" | "Open" | "Completed";
type BoardPane = "list" | "detail";

export interface TasksBoardSource {
	getSnapshot(): TaskSnapshot;
	getActivity(): SessionActivity | undefined;
	getConfig(): TaskDisplayConfig;
}

export interface TasksBoardState {
	selectedId?: number;
	filter: BoardFilter;
	collapseCompleted: boolean;
	query: string;
	searching: boolean;
	pane: BoardPane;
	listOffset: number;
	detailOffset: number;
	frame: number;
	error?: string;
	staleWarning?: boolean;
}

interface BoardProjection {
	all: Task[];
	visible: Task[];
	completed: Task[];
	selected?: Task;
	activity?: SessionActivity;
}

const FILTERS: readonly BoardFilter[] = ["All", "In progress", "Open", "Completed"];
const MIN_WIDTH = 36;
const MIN_ROWS = 14;
const MAX_FRAME_ROWS = 22;

interface BoardGeometry {
	frameHeight: number;
	contentRows: number;
	viewportRows: number;
	showPaneHeading: boolean;
	innerWidth: number;
	paneContentWidth: number;
	leftWidth?: number;
	leftContentWidth?: number;
	detailContentWidth: number;
}

function boardGeometry(width: number, terminalRows: number, footerRows: number, staleWarning: boolean): BoardGeometry {
	const innerWidth = width - 2;
	const frameHeight = Math.min(MAX_FRAME_ROWS, Math.floor(terminalRows * 0.85), terminalRows - 2);
	const contentRows = Math.max(1, frameHeight - 6 - footerRows - (staleWarning ? 1 : 0));
	const paneContentWidth = Math.max(1, innerWidth - 2);
	const showPaneHeading = contentRows > 1;
	const viewportRows = Math.max(1, contentRows - (showPaneHeading ? 1 : 0));
	if (width < 96) {
		return { frameHeight, contentRows, viewportRows, showPaneHeading, innerWidth, paneContentWidth, detailContentWidth: paneContentWidth };
	}
	const leftWidth = Math.max(34, Math.min(48, Math.floor((innerWidth - 1) * 0.39)));
	const rightWidth = innerWidth - leftWidth - 1;
	return {
		frameHeight,
		contentRows,
		viewportRows,
		showPaneHeading,
		innerWidth,
		paneContentWidth,
		leftWidth,
		leftContentWidth: Math.max(1, leftWidth - 2),
		detailContentWidth: Math.max(1, rightWidth - 2),
	};
}

function clip(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "");
}

function fill(line: string, width: number): string {
	const value = clip(line, width);
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function sides(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return clip(right, width);
	return fill(clip(left, width - rightWidth - 1), width - rightWidth) + right;
}

function counts(tasks: readonly Task[]): string {
	if (!tasks.length) return "0 tasks";
	const done = tasks.filter((task) => task.status === "completed").length;
	const active = tasks.filter((task) => task.status === "in_progress").length;
	const open = tasks.filter((task) => task.status === "pending").length;
	const groups = [done ? `${done} done` : "", active ? `${active} in progress` : "", open ? `${open} open` : ""].filter(Boolean);
	return `${tasks.length} tasks (${groups.join(", ")})`;
}

function matchingQuery(value: string): string {
	return sanitizeSearchInput(value).replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

const BRACKETED_PASTE_BEGIN = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const UNSAFE_UNFRAMED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u008f\u0091-\u0097\u0099-\u009c]/u;
const INPUT_CONTROL_BINDINGS: readonly Keybinding[] = [
	"tui.select.cancel",
	"tui.input.submit",
	"tui.editor.undo",
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteToLineEnd",
	"tui.editor.yank",
	"tui.editor.yankPop",
	"tui.editor.cursorLeft",
	"tui.editor.cursorRight",
	"tui.editor.cursorLineStart",
	"tui.editor.cursorLineEnd",
	"tui.editor.cursorWordLeft",
	"tui.editor.cursorWordRight",
];

function markerPrefixLength(value: string, marker: string): number {
	for (let length = Math.min(value.length, marker.length - 1); length > 0; length--) {
		if (marker.startsWith(value.slice(-length))) return length;
	}
	return 0;
}

/** Stateful ingress sanitizer; Input remains the sole owner of editable value and cursor state. */
class SearchInputIngress {
	private pendingBegin = "";
	private pastePayload = "";
	private inPaste = false;

	get isPasting(): boolean { return this.inPaste; }

	reset(): void {
		this.pendingBegin = "";
		this.pastePayload = "";
		this.inPaste = false;
	}

	consume(data: string, keybindings: KeybindingsManager): string[] {
		const output: string[] = [];
		this.consumeChunk(this.pendingBegin + data, keybindings, output);
		return output;
	}

	private consumeChunk(data: string, keybindings: KeybindingsManager, output: string[]): void {
		this.pendingBegin = "";
		if (this.inPaste) {
			this.pastePayload += data;
			const end = this.pastePayload.indexOf(BRACKETED_PASTE_END);
			if (end < 0) return;
			const payload = sanitizeSearchInput(this.pastePayload.slice(0, end));
			const remaining = this.pastePayload.slice(end + BRACKETED_PASTE_END.length);
			this.pastePayload = "";
			this.inPaste = false;
			output.push(`${BRACKETED_PASTE_BEGIN}${payload}${BRACKETED_PASTE_END}`);
			if (remaining) this.consumeChunk(remaining, keybindings, output);
			return;
		}

		const begin = data.indexOf(BRACKETED_PASTE_BEGIN);
		if (begin >= 0) {
			this.pushOrdinary(data.slice(0, begin), keybindings, output);
			this.inPaste = true;
			this.consumeChunk(data.slice(begin + BRACKETED_PASTE_BEGIN.length), keybindings, output);
			return;
		}

		const prefixLength = markerPrefixLength(data, BRACKETED_PASTE_BEGIN);
		if (prefixLength) {
			this.pendingBegin = data.slice(-prefixLength);
			this.pushOrdinary(data.slice(0, -prefixLength), keybindings, output);
			return;
		}
		this.pushOrdinary(data, keybindings, output);
	}

	private pushOrdinary(data: string, keybindings: KeybindingsManager, output: string[]): void {
		if (!data) return;
		if (data === "\n" || INPUT_CONTROL_BINDINGS.some((binding) => keybindings.matches(data, binding))) {
			output.push(data);
			return;
		}
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) {
			const printable = sanitizeSearchInput(kittyPrintable);
			if (printable) output.push(printable);
			return;
		}
		// A bare control mixed with text is ambiguous, so reject the whole construct.
		// Framed terminal strings and CSI/ESC sequences are removed by the sanitizer.
		if (UNSAFE_UNFRAMED_CONTROL.test(data)) return;
		const printable = sanitizeSearchInput(data);
		if (printable) output.push(printable);
	}
}

function taskSearchText(task: Task): string {
	return [`#${task.id}`, task.subject, task.activeForm ?? "", task.description ?? "", task.owner ?? ""]
		.map(sanitizeTerminalText)
		.join(" ")
		.replace(/\s+/gu, " ")
		.toLocaleLowerCase();
}

function project(snapshot: TaskSnapshot, activity: SessionActivity | undefined, config: TaskDisplayConfig, state: TasksBoardState): BoardProjection {
	const all = sortTasks(snapshot.tasks.filter((task) => task.status !== "deleted"), config.sortOrder);
	const completed = all.filter((task) => task.status === "completed");
	const query = matchingQuery(state.query);
	let visible = all.filter((task) => {
		if (state.filter === "In progress" && task.status !== "in_progress") return false;
		if (state.filter === "Open" && task.status !== "pending") return false;
		if (state.filter === "Completed" && task.status !== "completed") return false;
		if (query && !taskSearchText(task).includes(query)) return false;
		const revealCompleted = Boolean(query) || state.filter === "Completed";
		return task.status !== "completed" || !state.collapseCompleted || revealCompleted;
	});
	let selected = visible.find((task) => task.id === state.selectedId);
	if (!selected) selected = visible[0];
	return { all, visible, completed, selected, activity };
}

function formatTimestamp(value: number): string {
	try {
		return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
	} catch {
		return "—";
	}
}

function highlight(text: string, query: string, theme: Theme): string {
	const clean = sanitizeTerminalText(text);
	const needle = matchingQuery(query);
	if (!needle) return clean;
	const index = clean.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
	if (index < 0) return clean;
	const match = clean.slice(index, index + needle.length);
	return clean.slice(0, index) + theme.bg("searchMatchBg", theme.fg("searchMatchText", match)) + clean.slice(index + needle.length);
}

function wrapLabelValue(label: string, value: string, width: number, theme: Theme, query = ""): string[] {
	const labelWidth = 12;
	const safeWidth = Math.max(1, width);
	const valueWidth = Math.max(1, safeWidth - labelWidth);
	const rendered = query ? highlight(value, query, theme) : sanitizeTerminalText(value);
	const wrapped = wrapTextWithAnsi(rendered || "—", valueWidth);
	return wrapped.map((line, index) => `${index === 0 ? fill(theme.fg("muted", label), labelWidth) : " ".repeat(labelWidth)}${line}`);
}

function statusText(task: Task): string {
	return task.status === "in_progress" ? "in progress" : task.status;
}

function activeMetrics(task: Task, activity: SessionActivity | undefined, now: number, glyphs: ReturnType<typeof resolveTaskGlyphs>): string {
	const metrics = activity?.activeTaskId === task.id && activity.metrics
		? activity.metrics
		: { startedAt: now, inputTokens: 0, outputTokens: 0 };
	return `${formatDuration(now - metrics.startedAt)} · parent ${glyphs.inputTokens} ${formatTokens(metrics.inputTokens)} ${glyphs.outputTokens} ${formatTokens(metrics.outputTokens)}`;
}

function detailLines(task: Task, projection: BoardProjection, config: TaskDisplayConfig, theme: Theme, width: number, frame: number, now: number, query: string): string[] {
	const glyphs = resolveTaskGlyphs(config.glyphs);
	const lines: string[] = [];
	if (task.status === "in_progress") {
		lines.push(`${theme.fg("accent", glyphs.spinner[frame % glyphs.spinner.length]!)} ${theme.fg("accent", sanitizeTerminalText(task.activeForm || task.subject) + glyphs.trailingEllipsis)}`);
		lines.push(theme.fg("dim", `  ${activeMetrics(task, projection.activity, now, glyphs)}`));
	} else if (task.status === "completed") {
		lines.push(`${theme.fg("success", glyphs.completed)} ${theme.fg("dim", theme.strikethrough(sanitizeTerminalText(task.subject)))}`);
	} else {
		lines.push(`${glyphs.pending} ${sanitizeTerminalText(task.subject)}`);
	}
	lines.push("", theme.fg("muted", "Subject"));
	lines.push(...wrapTextWithAnsi(highlight(task.subject, query, theme), Math.max(1, width)));
	lines.push("", theme.fg("muted", "Description"));
	lines.push(...wrapTextWithAnsi(task.description ? highlight(task.description, query, theme) : theme.fg("dim", "(No description)"), Math.max(1, width)));
	lines.push("");
	lines.push(...wrapLabelValue("Status", statusText(task), width, theme));
	lines.push(...wrapLabelValue("Blocked by", task.blockedBy.length ? task.blockedBy.map((id) => `#${id}`).join(", ") : "—", width, theme));
	const blocking = projection.all.filter((candidate) => candidate.blockedBy.includes(task.id) && candidate.status !== "completed");
	lines.push(...wrapLabelValue("Blocking", blocking.length ? blocking.map((candidate) => `#${candidate.id}`).join(", ") : "—", width, theme));
	lines.push(...wrapLabelValue("Owner", task.owner || "—", width, theme, query));
	lines.push(...wrapLabelValue("Created", formatTimestamp(task.createdAt), width, theme));
	lines.push(...wrapLabelValue("Updated", formatTimestamp(task.updatedAt), width, theme));
	const metadataKeys = Object.keys(task.metadata).sort();
	if (!metadataKeys.length) {
		lines.push(...wrapLabelValue("Metadata", "—", width, theme));
	} else {
		const sortJson = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(sortJson);
			if (value && typeof value === "object") {
				return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortJson((value as Record<string, unknown>)[key])]));
			}
			return value;
		};
		const jsonLines = JSON.stringify(sortJson(task.metadata), null, 2).split("\n");
		for (const [index, jsonLine] of jsonLines.entries()) {
			const prefix = index === 0 ? fill(theme.fg("muted", "Metadata"), 12) : " ".repeat(12);
			lines.push(...wrapTextWithAnsi(prefix + sanitizeTerminalText(jsonLine), Math.max(1, width)));
		}
	}
	lines.push(...wrapLabelValue("Linked run", "Not linked", width, theme));
	return lines.map((line) => clip(line, width));
}

function taskRow(task: Task, selected: boolean, projection: BoardProjection, config: TaskDisplayConfig, theme: Theme, width: number, frame: number, now: number, query: string): string[] {
	const glyphs = resolveTaskGlyphs(config.glyphs);
	const prefix = selected ? theme.fg("accent", "›") : " ";
	const id = theme.fg("dim", `#${task.id}`);
	if (task.status === "completed") {
		const text = highlight(`#${task.id} ${task.subject}`, query, theme);
		const selectedText = selected ? theme.bold(text) : text;
		return [clip(`${prefix} ${theme.fg("success", glyphs.completed)} ${theme.fg("dim", theme.strikethrough(selectedText))}`, width)];
	}
	if (task.status === "in_progress") {
		const leading = `${prefix} ${theme.fg("accent", glyphs.spinner[frame % glyphs.spinner.length]!)} ${id} `;
		const action = theme.fg("accent", highlight(task.activeForm || task.subject, query, theme) + glyphs.trailingEllipsis);
		const metrics = theme.fg("dim", activeMetrics(task, projection.activity, now, glyphs).replace("parent ", ""));
		const inline = `${leading}${selected ? theme.bold(action) : action}  ${metrics}`;
		if (visibleWidth(inline) <= width) return [inline];
		const first = clip(`${leading}${selected ? theme.bold(action) : action}`, width);
		return [first, clip(`${" ".repeat(7)}${metrics}`, width)];
	}
	const blockers = task.blockedBy.filter((idValue) => projection.all.some((candidate) => candidate.id === idValue && candidate.status !== "completed"));
	const suffix = blockers.length ? theme.fg("dim", ` ${glyphs.blocked} blocked by ${blockers.map((idValue) => `#${idValue}`).join(", ")}`) : "";
	const leading = `${prefix} ${glyphs.pending} ${id} `;
	const subjectWidth = Math.max(0, width - visibleWidth(leading) - visibleWidth(suffix));
	const subject = truncateToWidth(highlight(task.subject, query, theme), subjectWidth, glyphs.truncation);
	return [clip(`${leading}${selected ? theme.bold(subject) : subject}${suffix}`, width)];
}

interface ListPage {
	rows: string[];
	firstTask: number;
	lastTask: number;
}

interface ListEntry {
	task: Task;
	rows: string[];
}

function physicalListStart(entries: readonly ListEntry[], selectedId: number | undefined, requestedOffset: number, viewportRows: number): number {
	if (!entries.length) return 0;
	const starts: number[] = [];
	let totalRows = 0;
	for (const entry of entries) {
		starts.push(totalRows);
		totalRows += entry.rows.length;
	}
	let start = Math.max(0, Math.min(Math.max(0, totalRows - viewportRows), requestedOffset));
	const selectedIndex = Math.max(0, entries.findIndex((entry) => entry.task.id === selectedId));
	const selectedStart = starts[selectedIndex]!;
	const selectedHeight = entries[selectedIndex]!.rows.length;
	const selectedEnd = selectedStart + selectedHeight;
	if (start > selectedStart) start = selectedStart;
	if (selectedEnd > start + viewportRows) {
		if (selectedHeight > viewportRows) start = selectedStart;
		else {
			const minimumStart = selectedEnd - viewportRows;
			start = starts.find((candidate) => candidate >= minimumStart && candidate <= selectedStart) ?? selectedStart;
		}
	}
	return start;
}

/** Paginate the physical rows emitted by taskRow, not the number of task records. */
function listPage(
	projection: BoardProjection,
	state: TasksBoardState,
	config: TaskDisplayConfig,
	theme: Theme,
	width: number,
	viewportRows: number,
	frame: number,
	now: number,
): ListPage {
	const entries: ListEntry[] = projection.visible.map((task) => ({
		task,
		rows: taskRow(task, task.id === projection.selected?.id, projection, config, theme, width, frame, now, state.query),
	}));
	const summary = state.collapseCompleted && !matchingQuery(state.query) && state.filter !== "Completed" && projection.completed.length
		? `${theme.fg("success", resolveTaskGlyphs(config.glyphs).completedSummary)} ${theme.fg("dim", `${projection.completed.length} completed`)}`
		: undefined;
	if (!entries.length) return { rows: [], firstTask: 0, lastTask: 0 };

	const start = physicalListStart(entries, projection.selected?.id, state.listOffset, viewportRows);
	const flattened = entries.flatMap((entry, taskIndex) => entry.rows.map((row) => ({ row, taskIndex })));
	if (summary) flattened.push({ row: summary, taskIndex: entries.length });
	const page = flattened.slice(start, start + viewportRows);
	const shownTasks = page.filter((row) => row.taskIndex < entries.length).map((row) => row.taskIndex);
	return {
		rows: page.map((row) => row.row),
		firstTask: shownTasks.length ? Math.min(...shownTasks) + 1 : 0,
		lastTask: shownTasks.length ? Math.max(...shownTasks) + 1 : 0,
	};
}

function bodyEmpty(projection: BoardProjection, state: TasksBoardState, theme: Theme): string[] {
	if (projection.visible.length) return [];
	if (!projection.all.length) return [theme.bold("No tasks in this session."), theme.fg("dim", "Use /tasks to create one; this board is read-only.")];
	if (matchingQuery(state.query)) return [theme.bold(`No tasks match \"${sanitizeSearchInput(state.query)}\".`), theme.fg("dim", "Esc clears search.")];
	if (state.filter !== "All") return [theme.bold(`No tasks match Filter: ${state.filter}.`), theme.fg("dim", "Press f to change the filter.")];
	if (projection.completed.length === projection.all.length && state.collapseCompleted) {
		return [theme.bold(`All ${projection.completed.length} tasks are completed.`), theme.fg("dim", "Press c to show completed tasks.")];
	}
	return [];
}

function frameRule(width: number, theme: Theme, leftWidth?: number, focused?: BoardPane, top = false): string {
	const inner = width - 2;
	if (leftWidth === undefined) return theme.fg("border", `├${"─".repeat(inner)}┤`);
	if (top) {
		return theme.fg("border", `├${"─".repeat(leftWidth)}`) + theme.fg("borderMuted", "┬") + theme.fg("border", `${"─".repeat(inner - leftWidth - 1)}┤`);
	}
	const leftRole = focused === "list" ? "borderAccent" : "border";
	const rightRole = focused === "detail" ? "borderAccent" : "border";
	return theme.fg("border", "├") + theme.fg(leftRole, "─".repeat(leftWidth)) + theme.fg("borderMuted", "┴") + theme.fg(rightRole, "─".repeat(inner - leftWidth - 1)) + theme.fg("border", "┤");
}

function bordered(content: string, width: number, theme: Theme): string {
	return theme.fg("border", "│") + fill(content, width - 2) + theme.fg("border", "│");
}

function keyLabel(keybindings: KeybindingsManager, binding: Parameters<KeybindingsManager["getKeys"]>[0], fallback: string): string {
	const key = keybindings.getKeys(binding)[0];
	if (!key) return fallback;
	return String(key).replace("pageUp", "PgUp").replace("pageDown", "PgDn").replace("escape", "Esc").replace("enter", "Enter").replace("backspace", "Backspace").replace("up", "↑").replace("down", "↓");
}

function packFooter(items: string[], width: number): string[] {
	const lines: string[] = [];
	for (const item of items) {
		const next = lines.length ? `${lines.at(-1)} · ${item}` : item;
		if (lines.length && visibleWidth(next) > width) lines.push(item);
		else if (lines.length) lines[lines.length - 1] = next;
		else lines.push(item);
	}
	return lines.flatMap((line) => visibleWidth(line) <= width ? [line] : wrapTextWithAnsi(line, Math.max(1, width)));
}

function footerLines(width: number, state: TasksBoardState, keybindings: KeybindingsManager, empty: boolean): string[] {
	const cancel = keyLabel(keybindings, "tui.select.cancel", "Esc");
	const select = keyLabel(keybindings, "tui.select.confirm", "Enter");
	const submit = keyLabel(keybindings, "tui.input.submit", "Enter");
	const up = keyLabel(keybindings, "tui.select.up", "↑");
	const down = keyLabel(keybindings, "tui.select.down", "↓");
	const pgUp = keyLabel(keybindings, "tui.select.pageUp", "PgUp");
	const pgDown = keyLabel(keybindings, "tui.select.pageDown", "PgDn");
	if (state.error) return packFooter(["r retry", `${cancel} close`], width);
	if (empty) return packFooter([`${cancel} close`, "/tasks manages tasks"], width);
	if (state.searching) return packFooter(["Type to filter", `${submit} keep`, "Backspace delete", `${cancel} clear`], width);
	if (state.pane === "detail" && width < 92) {
		return packFooter([`${up}${down}/jk scroll`, `${pgUp}/${pgDown} page`, "←/Backspace list", `${cancel} list`], width);
	}
	const items = [`${up}${down}/jk task`];
	if (width >= 92) items.push("Tab pane");
	else items.push(`${select} details`);
	items.push("/ search", "f filter", "c completed");
	if (width >= 92) items.push(`${pgUp}/${pgDown} scroll`);
	items.push(`${cancel} close`);
	return packFooter(items, width);
}

function controlLine(state: TasksBoardState, projection: BoardProjection, theme: Theme, width: number, input?: Input): string {
	if (state.searching) {
		const prefix = "Search ";
		const right = width >= 60 ? `${projection.visible.length} matches · Completed: shown in search` : "";
		const inputWidth = Math.max(3, width - visibleWidth(prefix) - (right ? visibleWidth(right) + 1 : 0));
		const renderedInput = input?.render(inputWidth)[0] ?? `> ${sanitizeSearchInput(state.query)}`;
		const left = prefix + renderedInput;
		return right ? sides(left, right, width) : clip(left, width);
	}
	if (width < 60) {
		const hidden = state.collapseCompleted && state.filter !== "Completed" ? projection.completed.length : 0;
		return `${state.filter} · ${projection.visible.length} shown${hidden ? ` · ${hidden} done hidden` : ""}`;
	}
	const shown = state.filter === "Completed" ? "shown by filter" : state.collapseCompleted ? "collapsed" : "shown";
	return sides("Search: / to search", `Filter: ${state.filter} · Completed: ${shown}`, width);
}

export interface RenderTasksBoardOptions {
	snapshot: TaskSnapshot;
	activity?: SessionActivity;
	config: TaskDisplayConfig;
	state: TasksBoardState;
	theme: Theme;
	keybindings: KeybindingsManager;
	width: number;
	terminalRows: number;
	now?: number;
	searchInput?: Input;
}

/** Pure board renderer. It never modifies task truth or display configuration. */
export function renderTasksBoard(options: RenderTasksBoardOptions): string[] {
	const { snapshot, activity, config, state, theme, keybindings } = options;
	const width = Math.max(1, options.width);
	if (width < MIN_WIDTH) return wrapTextWithAnsi("Tasks board needs at least 36 columns. Esc closes.", width).map((line) => clip(line, width));
	if (options.terminalRows < MIN_ROWS) return wrapTextWithAnsi("Tasks board needs at least 14 rows. Esc closes.", width).map((line) => clip(line, width));
	const now = options.now ?? Date.now();
	const projection = project(snapshot, activity, config, state);
	const selected = projection.visible.find((task) => task.id === state.selectedId) ?? projection.selected;
	const wide = width >= 96;
	const small = width < 60;
	const empty = projection.all.length === 0;
	const footer = footerLines(Math.max(1, width - 4), state, keybindings, empty);
	const geometry = boardGeometry(width, options.terminalRows, footer.length, Boolean(state.staleWarning));
	const { contentRows, innerWidth: inner } = geometry;
	const lines: string[] = [];
	lines.push(theme.fg("border", `╭${"─".repeat(inner)}╮`));
	const title = small ? `${theme.fg("accent", "●")} ${theme.bold("Tasks")} · ${theme.fg("muted", "read-only")}` : `${theme.fg("accent", "●")} ${theme.bold("Tasks")} · ${theme.fg("muted", "live, read-only")}`;
	const right = small ? `${projection.all.length} ${projection.all.length === 1 ? "task" : "tasks"}` : counts(projection.all);
	lines.push(bordered(` ${sides(title, theme.fg("muted", right), inner - 2)} `, width, theme));
	lines.push(bordered(` ${controlLine(state, projection, theme, inner - 2, options.searchInput)} `, width, theme));

	const errorBody = state.error
		? [theme.fg("error", "Tasks could not be displayed."), theme.fg("error", sanitizeTerminalText(state.error))]
		: bodyEmpty(projection, state, theme);
	if (wide) {
		const leftWidth = geometry.leftWidth!;
		const leftContent = geometry.leftContentWidth!;
		const rightContent = geometry.detailContentWidth;
		const viewport = geometry.viewportRows;
		lines.push(frameRule(width, theme, leftWidth, state.pane, true));
		const page = listPage(projection, state, config, theme, leftContent, viewport, state.frame, now);
		const listHeading = projection.visible.length
			? `Tasks  ${Math.max(1, projection.visible.findIndex((task) => task.id === selected?.id) + 1)}/${projection.visible.length}${page.firstTask && (page.firstTask > 1 || page.lastTask < projection.visible.length) ? ` · rows ${page.firstTask}–${page.lastTask}` : ""}`
			: "Tasks  0/0";
		const detail = selected ? detailLines(selected, projection, config, theme, rightContent, state.frame, now, state.query) : errorBody;
		const detailOffset = Math.min(state.detailOffset, Math.max(0, detail.length - viewport));
		const detailVisible = detail.slice(detailOffset, detailOffset + viewport);
		const detailHeading = selected
			? `Details  #${selected.id} · lines ${detail.length ? detailOffset + 1 : 0}–${detailOffset + detailVisible.length}/${detail.length}`
			: "Details";
		const leftMarker = state.pane === "list" ? "› " : "";
		const detailMarker = state.pane === "detail" ? "› " : "";
		const leftRows = geometry.showPaneHeading
			? [state.pane === "list" ? theme.fg("accent", theme.bold(leftMarker + listHeading)) : theme.bold(listHeading)]
			: [];
		if (errorBody.length) leftRows.push(...errorBody);
		else leftRows.push(...page.rows);
		const rightRows = geometry.showPaneHeading
			? [state.pane === "detail" ? theme.fg("accent", theme.bold(detailMarker + detailHeading)) : theme.bold(detailHeading), ...detailVisible]
			: detailVisible;
		for (let row = 0; row < contentRows; row++) {
			lines.push(theme.fg("border", "│") + ` ${fill(leftRows[row] ?? "", leftContent)} ` + theme.fg("borderMuted", "│") + ` ${fill(rightRows[row] ?? "", rightContent)} ` + theme.fg("border", "│"));
		}
		lines.push(frameRule(width, theme, leftWidth, state.pane));
	} else {
		lines.push(frameRule(width, theme));
		const paneContent = geometry.paneContentWidth;
		const viewport = geometry.viewportRows;
		let body: string[] = [];
		let heading = "";
		if (state.pane === "detail" && selected) {
			const detail = detailLines(selected, projection, config, theme, paneContent, state.frame, now, state.query);
			const detailOffset = Math.min(state.detailOffset, Math.max(0, detail.length - viewport));
			const visible = detail.slice(detailOffset, detailOffset + viewport);
			heading = `Details  #${selected.id} · lines ${detail.length ? detailOffset + 1 : 0}–${detailOffset + visible.length}/${detail.length}`;
			body = visible;
		} else {
			const page = listPage(projection, state, config, theme, paneContent, viewport, state.frame, now);
			heading = projection.visible.length
				? `Tasks  ${Math.max(1, projection.visible.findIndex((task) => task.id === selected?.id) + 1)}/${projection.visible.length}${page.firstTask && (page.firstTask > 1 || page.lastTask < projection.visible.length) ? ` · rows ${page.firstTask}–${page.lastTask}` : ""}`
				: "Tasks  0/0";
			body = errorBody.length ? errorBody : page.rows;
		}
		if (geometry.showPaneHeading) lines.push(bordered(` ${clip(theme.fg("accent", theme.bold(heading)), paneContent)} `, width, theme));
		for (let row = 0; row < viewport; row++) lines.push(bordered(` ${fill(body[row] ?? "", paneContent)} `, width, theme));
		lines.push(frameRule(width, theme));
	}
	if (state.staleWarning) lines.splice(lines.length - 1, 0, bordered(` ${theme.fg("warning", "Could not refresh tasks; showing the last valid snapshot.")} `, width, theme));
	for (const footerLine of footer) lines.push(bordered(` ${theme.fg("dim", footerLine)} `, width, theme));
	lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
	return lines.map((line) => clip(line, width));
}

export interface TasksBoardComponentOptions {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	done: () => void;
	source: TasksBoardSource;
	now?: () => number;
}

export class TasksBoardComponent implements Component, Focusable {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly done: () => void;
	private readonly source: TasksBoardSource;
	private readonly now: () => number;
	private readonly searchInput = new Input();
	private readonly searchIngress = new SearchInputIngress();
	private interval?: ReturnType<typeof setInterval>;
	private disposed = false;
	private _focused = false;
	private lastSnapshot?: TaskSnapshot;
	private lastActivity?: SessionActivity;
	private lastConfig?: TaskDisplayConfig;
	private lastWidth = 80;
	private lastRows = 24;
	private projectionState?: string;
	readonly state: TasksBoardState;

	constructor(options: TasksBoardComponentOptions) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.done = options.done;
		this.source = options.source;
		this.now = options.now ?? Date.now;
		const config = this.source.getConfig();
		this.state = { filter: "All", collapseCompleted: config.collapseCompleted, query: "", searching: false, pane: "list", listOffset: 0, detailOffset: 0, frame: 0 };
		this.searchInput.onSubmit = () => { this.state.searching = false; this.searchInput.focused = false; this.searchIngress.reset(); this.changed(); };
		this.searchInput.onEscape = () => this.clearSearch();
	}

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) { this._focused = value; this.searchInput.focused = value && this.state.searching; }

	private read(): BoardProjection | undefined {
		try {
			this.lastSnapshot = this.source.getSnapshot();
			this.lastActivity = this.source.getActivity();
			this.lastConfig = this.source.getConfig();
			this.state.error = undefined;
			this.state.staleWarning = false;
		} catch (error) {
			if (this.lastSnapshot && this.lastConfig) this.state.staleWarning = true;
			else this.state.error = sanitizeTerminalText(error instanceof Error ? error.message : error);
		}
		if (!this.lastSnapshot || !this.lastConfig) return undefined;
		const result = project(this.lastSnapshot, this.lastActivity, this.lastConfig, this.state);
		const projectionState = JSON.stringify([this.state.query, this.state.filter, this.state.collapseCompleted]);
		if (projectionState !== this.projectionState) {
			this.projectionState = projectionState;
			this.state.listOffset = 0;
			this.state.detailOffset = 0;
		}
		const selected = result.visible.find((task) => task.id === this.state.selectedId) ?? result.selected;
		if (selected?.id !== this.state.selectedId) {
			this.state.selectedId = selected?.id;
			this.state.detailOffset = 0;
		}
		if (!selected) this.state.listOffset = 0;
		else {
			const geometry = this.geometry(result);
			const width = geometry.leftContentWidth ?? geometry.paneContentWidth;
			const entries: ListEntry[] = result.visible.map((task) => ({
				task,
				rows: taskRow(task, task.id === selected.id, result, this.lastConfig!, this.theme, width, this.state.frame, this.now(), this.state.query),
			}));
			this.state.listOffset = physicalListStart(entries, selected.id, this.state.listOffset, geometry.viewportRows);
		}
		if (!selected && this.lastWidth < 96) this.state.pane = "list";
		this.syncTimer(result.all.some((task) => task.status === "in_progress"));
		return result;
	}

	private syncTimer(active: boolean): void {
		if (active && !this.interval && !this.disposed) {
			this.interval = setInterval(() => {
				this.state.frame++;
				this.invalidate();
				this.tui.requestRender();
			}, SPINNER_INTERVAL_MS);
			(this.interval as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
		} else if (!active) this.stopTimer();
	}

	private stopTimer(): void {
		if (this.interval) clearInterval(this.interval);
		this.interval = undefined;
	}

	private changed(): void {
		this.read();
		this.tui.requestRender();
	}

	private clearSearch(): void {
		if (!this.state.query && !this.state.searching) return;
		this.searchIngress.reset();
		this.searchInput.setValue("");
		this.state.query = "";
		this.state.searching = false;
		this.searchInput.focused = false;
		this.state.listOffset = 0;
		this.changed();
	}

	private geometry(projection: BoardProjection): BoardGeometry {
		const footer = footerLines(Math.max(1, this.lastWidth - 4), this.state, this.keybindings, projection.all.length === 0);
		return boardGeometry(this.lastWidth, this.lastRows, footer.length, Boolean(this.state.staleWarning));
	}

	private moveSelection(delta: number, absolute?: "first" | "last"): void {
		const projection = this.read();
		if (!projection?.visible.length) return;
		const current = Math.max(0, projection.visible.findIndex((task) => task.id === this.state.selectedId));
		const next = absolute === "first" ? 0 : absolute === "last" ? projection.visible.length - 1 : Math.max(0, Math.min(projection.visible.length - 1, current + delta));
		const id = projection.visible[next]?.id;
		if (id !== this.state.selectedId) {
			this.state.selectedId = id;
			this.state.detailOffset = 0;
		}
		this.changed();
	}

	private moveSelectionPage(direction: -1 | 1): void {
		const projection = this.read();
		if (!projection?.visible.length || !this.lastConfig) return;
		const current = Math.max(0, projection.visible.findIndex((task) => task.id === this.state.selectedId));
		const geometry = this.geometry(projection);
		const width = geometry.leftContentWidth ?? geometry.paneContentWidth;
		const budget = Math.max(1, geometry.viewportRows - 1);
		let used = 0;
		let next = current;
		while (next + direction >= 0 && next + direction < projection.visible.length) {
			const candidate = next + direction;
			const height = taskRow(projection.visible[candidate]!, false, projection, this.lastConfig, this.theme, width, this.state.frame, this.now(), this.state.query).length;
			if (used > 0 && used + height > budget) break;
			used += height;
			next = candidate;
		}
		this.moveSelection(next - current);
	}

	private scrollDetail(delta: number): void {
		const projection = this.read();
		const selected = projection?.visible.find((task) => task.id === this.state.selectedId) ?? projection?.selected;
		if (!projection || !selected || !this.lastConfig) return;
		const geometry = this.geometry(projection);
		const total = detailLines(selected, projection, this.lastConfig, this.theme, geometry.detailContentWidth, this.state.frame, this.now(), this.state.query).length;
		this.state.detailOffset = Math.max(0, Math.min(Math.max(0, total - geometry.viewportRows), this.state.detailOffset + delta));
		this.changed();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.state.searching) {
			if (!this.searchIngress.isPasting && this.keybindings.matches(data, "tui.select.cancel")) { this.clearSearch(); return; }
			if (!this.searchIngress.isPasting && this.keybindings.matches(data, "tui.input.submit")) {
				this.state.searching = false;
				this.searchInput.focused = false;
				this.searchIngress.reset();
				this.changed();
				return;
			}
			for (const input of this.searchIngress.consume(data, this.keybindings)) this.searchInput.handleInput(input);
			this.state.query = this.searchInput.getValue();
			// Input cursor movement and IME positioning change rendering even when the value does not.
			this.changed();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.state.query) this.clearSearch();
			else if (this.state.pane === "detail" && this.lastWidth < 96) { this.state.pane = "list"; this.changed(); }
			else this.close();
			return;
		}
		if ((matchesKey(data, Key.left) || matchesKey(data, Key.backspace) || data === "h") && this.state.pane === "detail" && this.lastWidth < 96) {
			this.state.pane = "list"; this.changed(); return;
		}
		if (data === "q" && (this.state.pane === "list" || this.lastWidth >= 96)) { this.close(); return; }
		if (data === "/") {
			this.searchIngress.reset();
			this.state.searching = true;
			this.searchInput.focused = this.focused;
			this.changed(); return;
		}
		if (data === "f") {
			this.state.filter = FILTERS[(FILTERS.indexOf(this.state.filter) + 1) % FILTERS.length]!;
			this.state.listOffset = 0;
			this.changed(); return;
		}
		if (data === "c") { this.state.collapseCompleted = !this.state.collapseCompleted; this.state.listOffset = 0; this.changed(); return; }
		if (data === "r" && this.state.error) { this.state.error = undefined; this.changed(); return; }
		if (this.lastWidth >= 96 && matchesKey(data, Key.tab)) { this.state.pane = this.state.pane === "list" ? "detail" : "list"; this.changed(); return; }
		if (this.keybindings.matches(data, "tui.select.confirm") && this.state.pane === "list") { this.state.pane = "detail"; this.changed(); return; }
		const detailFocused = this.state.pane === "detail";
		const projection = this.read();
		const page = projection ? Math.max(1, this.geometry(projection).viewportRows - 1) : 1;
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") detailFocused ? this.scrollDetail(-1) : this.moveSelection(-1);
		else if (this.keybindings.matches(data, "tui.select.down") || data === "j") detailFocused ? this.scrollDetail(1) : this.moveSelection(1);
		else if (this.keybindings.matches(data, "tui.select.pageUp")) detailFocused ? this.scrollDetail(-page) : this.moveSelectionPage(-1);
		else if (this.keybindings.matches(data, "tui.select.pageDown")) detailFocused ? this.scrollDetail(page) : this.moveSelectionPage(1);
		else if (matchesKey(data, Key.home)) detailFocused ? this.scrollDetail(-Number.MAX_SAFE_INTEGER) : this.moveSelection(0, "first");
		else if (matchesKey(data, Key.end)) detailFocused ? this.scrollDetail(Number.MAX_SAFE_INTEGER) : this.moveSelection(0, "last");
	}

	render(width: number): string[] {
		this.lastWidth = Math.max(1, width);
		this.lastRows = this.tui.terminal.rows;
		this.read();
		const snapshot = this.lastSnapshot ?? { kind: "pi.tasks.snapshot", schemaVersion: 1, revision: 0, nextId: 1, tasks: [] };
		const config = this.lastConfig ?? this.source.getConfig();
		return renderTasksBoard({ snapshot, activity: this.lastActivity, config, state: this.state, theme: this.theme, keybindings: this.keybindings, width: this.lastWidth, terminalRows: this.lastRows, now: this.now(), searchInput: this.searchInput });
	}

	invalidate(): void { this.searchInput.invalidate(); }

	close(): void {
		if (this.disposed) return;
		this.dispose();
		this.done();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stopTimer();
	}
}

let boardOpen = false;
let activeBoard: TasksBoardComponent | undefined;

export async function openTasksBoard(ctx: ExtensionCommandContext, getConfig: () => TaskDisplayConfig): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/tasks-board requires TUI mode; task data remains available through the todo tool.", "warning");
		return;
	}
	if (boardOpen) {
		ctx.ui.notify("Tasks board is already open.", "info");
		return;
	}
	boardOpen = true;
	try {
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			activeBoard = new TasksBoardComponent({
				tui,
				theme,
				keybindings,
				done,
				source: {
					getSnapshot: foregroundSnapshot,
					getActivity: () => taskActivity.get(getForeground()),
					getConfig,
				},
			});
			return activeBoard;
		}, { overlay: true, overlayOptions: TASKS_BOARD_OVERLAY_OPTIONS });
	} catch (error) {
		ctx.ui.notify(`Could not open Tasks board: ${sanitizeTerminalText(error instanceof Error ? error.message : error)}`, "error");
	} finally {
		activeBoard?.dispose();
		activeBoard = undefined;
		boardOpen = false;
	}
}

export function disposeTasksBoard(): void {
	activeBoard?.close();
}
