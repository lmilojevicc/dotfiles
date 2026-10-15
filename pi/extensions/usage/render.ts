import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	formatResetShort,
	formatUsedPercent,
	usageBar,
	type ProviderSnapshot,
	type ProviderStateError,
	type UsageRow,
} from "./core.ts";

export type TabError = { message: string; state?: ProviderStateError["state"] };
export type TabState = { snapshot?: ProviderSnapshot; error?: TabError; loading: boolean };

/** One line of the scrollable band; `heading` marks a group section heading line. */
export type BandLine = { line: string; heading?: boolean };

/** Structured tab body: fixed head, scrollable band, fixed foot. Concatenated they are the flat body. */
export type FrameBody = {
	/** Fixed lines above the band: title, blank, column header row and header rule (or free-form status lines). */
	head: string[];
	/** Scrollable table lines; group section headings are part of the band and scroll with the rows. */
	band: BandLine[];
	/** Fixed lines below the band: notes, including their leading blank separator. */
	foot: string[];
};

/** The first column is the row label (account, limit name or provider); `Item` is the neutral shared header. */
const TABLE_HEADERS = ["Item", "Window", "Used", "", "Reset", "Status"];
const BAR_COLUMN = 2;
const PERCENT_COLUMN = 3;

/** Layout with terminal cells, not string length; truncation is only the outer safety net. */
export function wrappedLines(text: string, width: number): string[] {
	return wrapTextWithAnsi(text, Math.max(1, width - 2)).map((line) => `  ${line}`);
}

export function packControls(controls: string[], width: number): string[] {
	const lines: string[] = [];
	for (const control of controls) {
		const previous = lines.at(-1);
		if (previous && visibleWidth(`${previous} · ${control}`) <= width - 2) lines[lines.length - 1] = `${previous} · ${control}`;
		else lines.push(...wrapTextWithAnsi(control, Math.max(1, width - 2)));
	}
	return lines;
}

/**
 * Dynamic tab bar: every tab when it fits, then a tighter separator, then a
 * window around the active tab with ‹ › markers. The active tab is never dropped.
 */
export function formatTabBar(theme: Theme, titles: readonly string[], active: number, width: number): string {
	if (!titles.length) return "";
	const label = (index: number) => index === active ? theme.bold(titles[index]!) : theme.fg("dim", titles[index]!);
	for (const separator of ["  /  ", " / "]) {
		const line = `  ${titles.map((_, index) => label(index)).join(theme.fg("dim", separator))}`;
		if (visibleWidth(line) <= width) return line;
	}
	const separator = theme.fg("dim", " / ");
	const build = (low: number, high: number) => {
		const parts: string[] = [];
		for (let index = low; index <= high; index += 1) parts.push(label(index));
		return `  ${low > 0 ? theme.fg("dim", "‹ ") : ""}${parts.join(separator)}${high < titles.length - 1 ? theme.fg("dim", " ›") : ""}`;
	};
	let low = active;
	let high = active;
	for (let grew = true; grew;) {
		grew = false;
		if (high < titles.length - 1 && visibleWidth(build(low, high + 1)) <= width) { high += 1; grew = true; }
		if (low > 0 && visibleWidth(build(low - 1, high)) <= width) { low -= 1; grew = true; }
	}
	if (visibleWidth(build(low, high)) <= width) return build(low, high);
	const markers = (active > 0 ? 2 : 0) + (active < titles.length - 1 ? 2 : 0);
	const title = truncateToWidth(titles[active]!, Math.max(1, width - 2 - markers), "…");
	return `  ${active > 0 ? theme.fg("dim", "‹ ") : ""}${theme.bold(title)}${active < titles.length - 1 ? theme.fg("dim", " ›") : ""}`;
}

function rowLines(row: UsageRow, now: number): string[][] {
	if (!row.windows.length) return [[row.label, "", "", "", "", row.state ?? ""]];
	return row.windows.map((window, index) => [
		index === 0 ? row.label : "",
		window.label,
		usageBar(window.usedPercent),
		formatUsedPercent(window.usedPercent),
		formatResetShort(window.resetsAt, now),
		[index === 0 ? row.state : undefined, window.note].filter(Boolean).join(" · "),
	]);
}

function columnWidths(rows: string[][]): number[] {
	return Array.from({ length: Math.max(...rows.map((row) => row.length)) }, (_, index) =>
		Math.max(...rows.map((row) => visibleWidth(row[index] ?? ""))));
}

function formatRow(row: string[], widths: number[]): string {
	return `  ${row.map((cell, index) => index === row.length - 1 ? cell : cell + " ".repeat(Math.max(0, (widths[index] ?? 0) - visibleWidth(cell)))).join("  ")}`.trimEnd();
}

function tableWidth(widths: number[]): number {
	return widths.reduce((sum, width) => sum + width, 0) + 2 * Math.max(0, widths.length - 1);
}

/** Groups render in first-seen order; empty columns are dropped and the bar goes first when narrow. */
export function formatUsageTableParts(theme: Theme, rows: readonly UsageRow[], width: number, now = Date.now()): { head: string[]; band: BandLine[] } {
	const groups: Array<{ name?: string; rows: UsageRow[] }> = [];
	for (const row of rows) {
		const group = groups.find((entry) => entry.name === row.group);
		if (group) group.rows.push(row);
		else groups.push({ name: row.group, rows: [row] });
	}
	const sections = groups.map((group) => ({ name: group.name, lines: group.rows.flatMap((row) => rowLines(row, now)) }));
	const data = sections.flatMap((section) => section.lines);
	let headers = TABLE_HEADERS;
	let keep = headers.map((_, index) => index === 0 || data.some((line) => (line[index] ?? "") !== ""));
	const project = (line: string[]) => line.filter((_, index) => keep[index]);
	let widths = columnWidths([project(headers), ...data.map(project)]);
	if (tableWidth(widths) + 2 > width && keep[BAR_COLUMN]) {
		keep = keep.map((value, index) => index === BAR_COLUMN ? false : value);
		headers = headers.map((header, index) => index === PERCENT_COLUMN ? headers[BAR_COLUMN]! : header);
		widths = columnWidths([project(headers), ...data.map(project)]);
	}
	const head = [
		formatRow(project(headers).map((header) => header ? theme.fg("dim", header) : header), widths),
		theme.fg("borderMuted", `  ${"─".repeat(Math.max(0, Math.min(tableWidth(widths), width - 2)))}`),
	];
	const band: BandLine[] = [];
	for (const section of sections) {
		if (section.name !== undefined) band.push({ line: `  ${theme.fg("muted", section.name)}`, heading: true });
		for (const line of section.lines) band.push({ line: formatRow(project(line), widths) });
	}
	return { head, band };
}

/** Flat table lines: column header, header rule, then every band line. */
export function formatUsageTable(theme: Theme, rows: readonly UsageRow[], width: number, now = Date.now()): string[] {
	const table = formatUsageTableParts(theme, rows, width, now);
	return [...table.head, ...table.band.map((entry) => entry.line)];
}

export function formatProviderBody(theme: Theme, title: string, state: TabState | undefined, width: number, now = Date.now()): FrameBody {
	if (!state || (!state.snapshot && !state.error)) return { head: [theme.fg("dim", `  Loading ${title} usage…`)], band: [], foot: [] };
	if (state.error) {
		return {
			head: [
				...wrappedLines(theme.fg(state.error.state ? "warning" : "error", state.error.message), width),
				theme.fg("dim", state.loading ? "  Retrying…" : "  Press R to retry."),
			],
			band: [],
			foot: [],
		};
	}
	const snapshot = state.snapshot!;
	const table = formatUsageTableParts(theme, snapshot.rows, width, now);
	return {
		head: [
			`  ${theme.bold(`${snapshot.title}${snapshot.subtitle ? ` · ${snapshot.subtitle}` : ""}`)}${state.loading ? theme.fg("dim", "  refreshing…") : ""}`,
			"",
			...(snapshot.rows.length ? table.head : [theme.fg("dim", "  No usage data.")]),
		],
		band: snapshot.rows.length ? table.band : [],
		foot: snapshot.notes?.length ? ["", ...snapshot.notes.flatMap((note) => wrappedLines(theme.fg("dim", note), width))] : [],
	};
}

export function formatProviderLines(theme: Theme, title: string, state: TabState | undefined, width: number, now = Date.now()): string[] {
	const body = formatProviderBody(theme, title, state, width, now);
	return [...body.head, ...body.band.map((entry) => entry.line), ...body.foot];
}

export type FrameInput = {
	titles: readonly string[];
	active: number;
	body: string[];
};

/** Effective frame height in terminal rows; missing or absurd (< 8 or > 200) values fall back to 24. */
export function frameHeight(rows: number | undefined): number {
	return typeof rows === "number" && Number.isFinite(rows) && rows >= 8 && rows <= 200 ? Math.floor(rows) : 24;
}

/**
 * Rows kept back from the terminal height for Pi's own chrome below the component (status line and
 * its key hints). Without this the frame claims the full terminal and the last lines are clipped.
 */
export const STATUSLINE_RESERVE = 2;

/** Minimum band rows; a frame always shows at least one quota row. */
const MIN_BAND_ROWS = 1;
/** Rows the band keeps before foot notes are allowed to take space. */
const COMFORT_BAND_ROWS = 3;

export type BandWindow = {
	/** Visible band lines: a pure window, never padded or shortened for a heading. */
	lines: string[];
	/** Clamped offset actually used. */
	offset: number;
	/** Window size: how many band lines the band can show. */
	bandSize: number;
	/** Largest valid offset, i.e. the start of the last full band. */
	maxOffset: number;
	/** First and last visible band line indexes (0-based, inclusive). */
	first: number;
	last: number;
	total: number;
	/** Governing section heading when the window starts mid-section; shown in the frame title. */
	heading?: string;
};

/**
 * Window the band at `offset`, clamped to [0, last full band] with no wrap-around. The window is
 * always exactly `bandSize` rows (or fewer at the end of the content), so paging by `bandSize`
 * always advances. When the window starts mid-section the governing group heading is returned as
 * `heading` metadata for the caller to show in its fixed chrome; it never consumes a band row.
 */
export function scrollBand(band: readonly BandLine[], offset: number, bandSize: number): BandWindow {
	const total = band.length;
	const size = Math.max(1, Math.floor(bandSize));
	const maxOffset = Math.max(0, total - size);
	const requested = typeof offset === "number" && !Number.isNaN(offset) ? Math.floor(offset) : 0;
	const clamped = Math.max(0, Math.min(requested, maxOffset));
	const window = band.slice(clamped, clamped + size);
	// A window starting mid-section keeps its governing heading, but as metadata rather than as an
	// extra line: stealing a band row would shrink the window and collapse page-by-page scrolling.
	let heading: string | undefined;
	if (window.length > 0 && !window[0]!.heading) {
		for (let index = clamped - 1; index >= 0; index -= 1) {
			if (band[index]!.heading) {
				heading = band[index]!.line.trim();
				break;
			}
		}
	}
	return {
		lines: window.map((entry) => entry.line),
		offset: clamped,
		bandSize: size,
		maxOffset,
		first: window.length ? clamped : 0,
		last: window.length ? clamped + window.length - 1 : 0,
		total,
		...(heading === undefined ? {} : { heading }),
	};
}

export type ScrollFrameInput = FrameBody & {
	titles: readonly string[];
	active: number;
	/** Requested band offset; clamped to the last full band. */
	offset?: number;
	/** Effective height from frameHeight(); undefined renders the full band (flat legacy behavior). */
	height?: number;
};

export type ScrollFrame = {
	lines: string[];
	/** Band offset actually rendered, after clamping. */
	offset: number;
	/** Visible band window size used for this render. */
	bandSize: number;
	/** Largest valid band offset for the current content and height. */
	maxOffset: number;
	/** True when the band overflowed: the range indicator and scroll hints are shown. */
	overflow: boolean;
};

/**
 * Frame with fixed chrome and a scrollable band. When the content fits the height the frame is
 * exactly the flat layout; otherwise the band is windowed, a dim `rows A-B of C` indicator follows
 * it and the controls gain scroll hints.
 *
 * A finite height is a hard budget, and quota rows outrank foot notes: notes are reduced (and a
 * `+N more` marker substituted) before the band drops below `COMFORT_BAND_ROWS`, and the header or
 * title are dropped only when even the chrome cannot fit. The band always keeps at least one row.
 */
export function formatScrollFrame(theme: Theme, input: ScrollFrameInput, width: number): ScrollFrame {
	const controls = [
		...(input.titles.length > 1 ? ["Tab next", "Shift+Tab previous"] : []),
		...(input.titles.length ? ["R refresh"] : []),
		"Esc close",
	];
	const top = [
		theme.fg("accent", "─".repeat(Math.max(0, width))),
		...(input.titles.length ? [formatTabBar(theme, input.titles, input.active, width), theme.fg("borderMuted", "─".repeat(Math.max(0, width)))] : []),
	];
	const bottomRule = theme.fg("accent", "─".repeat(Math.max(0, width)));
	const height = input.height ?? Number.POSITIVE_INFINITY;
	const styleControls = (lines: string[]) => lines.map((line) => `  ${theme.fg("muted", line)}`);
	const baseControls = packControls(controls, width);
	const flatLines = [
		...top,
		...input.head,
		...input.band.map((entry) => entry.line),
		...input.foot,
		"",
		...styleControls(baseControls),
		bottomRule,
	].map((line) => truncateToWidth(line, width, ""));
	if (flatLines.length <= height) {
		return { lines: flatLines, offset: 0, bandSize: input.band.length, maxOffset: 0, overflow: false };
	}
	// Error, loading and empty states carry no band, but their frame still has to fit the pane.
	const emptyBand = input.band.length === 0;

	const hintedControls = packControls([...controls.slice(0, -1), "↑↓/jk scroll", "J/K page", "Esc close"], width);
	const budget = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : Number.POSITIVE_INFINITY;
	const title = input.head.slice(0, 1);
	const headerLines = input.head.slice(1);
	// A finite height is a hard budget. Chrome is given up in a fixed order — blank separator,
	// header, title, notes, tab bar, range indicator — so the band and the controls (including the
	// way out) survive on a short terminal instead of being clipped.
	type Chrome = { top: string[]; indicator: boolean; blank: boolean; head: boolean; notes: boolean };
	const chromes: Chrome[] = [
		{ top, indicator: true, blank: true, head: true, notes: true },
		{ top, indicator: true, blank: false, head: true, notes: true },
		{ top, indicator: true, blank: false, head: false, notes: false },
		{ top: top.slice(0, 1), indicator: true, blank: false, head: false, notes: false },
		{ top: top.slice(0, 1), indicator: false, blank: false, head: false, notes: false },
	];
	let picked: { lines: string[]; window: BandWindow } | undefined;
	let fallback: { lines: string[]; window: BandWindow } | undefined;
	for (const chrome of chromes) {
		const wantIndicator = chrome.indicator && !emptyBand;
		const fixed = chrome.top.length + hintedControls.length + (wantIndicator ? 1 : 0) + (chrome.blank ? 1 : 0) + 1;
		let space = budget - fixed - MIN_BAND_ROWS;
		let showTitle = false;
		let showHeader = false;
		let notes: string[] = [];
		if (space >= 0 && chrome.head) {
			const headCost = (title.length ? 1 : 0) + headerLines.length;
			if (space - headCost >= MIN_BAND_ROWS) {
				showTitle = title.length > 0;
				showHeader = headerLines.length > 0;
				space -= headCost;
			} else if (title.length > 0 && space - 1 >= MIN_BAND_ROWS) {
				// The title names the snapshot, so it outranks the column header when space is short.
				showTitle = true;
				space -= 1;
			} else if (space - headerLines.length >= MIN_BAND_ROWS) {
				showHeader = headerLines.length > 0;
				space -= headerLines.length;
			}
		}
		if (space >= 0 && chrome.notes) {
			// Notes are last: they only take space the band does not need to stay comfortable.
			const taken = Math.max(0, Math.min(input.foot.length, space - COMFORT_BAND_ROWS));
			notes = input.foot.slice(0, taken);
			space -= taken;
			const dropped = input.foot.length - taken;
			if (dropped > 0 && space - 1 >= 0) {
				notes.push(`  ${theme.fg("dim", `… +${dropped} more`)}`);
				space -= 1;
			}
		}
		const bandRows = MIN_BAND_ROWS + Math.max(0, space);
		const window = scrollBand(input.band, input.offset ?? 0, bandRows);
		// The governing section heading rides in the title line, costing no band row.
		const titleLine = showTitle && window.heading !== undefined
			? `${title[0]} ${theme.fg("dim", `› ${window.heading}`)}`
			: title[0];
		const indicator = `  ${theme.fg("dim", `rows ${window.first + 1}-${window.last + 1} of ${window.total}`)}`;
		const lines = [
			...chrome.top,
			...(showTitle && titleLine !== undefined ? [titleLine] : []),
			...(showHeader ? headerLines : []),
			...window.lines,
			...(wantIndicator ? [indicator] : []),
			...notes,
			...(chrome.blank ? [""] : []),
			...styleControls(hintedControls),
			bottomRule,
		].map((line) => truncateToWidth(line, width, ""));
		fallback ??= { lines, window };
		if (lines.length <= budget) {
			picked = { lines, window };
			break;
		}
	}
	const chosen = picked ?? fallback!;
	let lines = chosen.lines;
	if (lines.length > budget) {
		// Only reachable when the fixed chrome alone exceeds an absurdly short or narrow terminal:
		// keep the visible top of the frame plus the exit hint and the bottom rule, so the frame
		// boundary and the way out survive the clamp.
		const exitHint = styleControls(hintedControls).at(-1) ?? "";
		lines = [...lines.slice(0, Math.max(0, budget - 2)), exitHint, bottomRule];
	}
	return {
		lines,
		offset: chosen.window.offset,
		bandSize: chosen.window.bandSize,
		maxOffset: chosen.window.maxOffset,
		overflow: !emptyBand,
	};
}

export function formatFrame(theme: Theme, input: FrameInput, width: number): string[] {
	return formatScrollFrame(theme, { titles: input.titles, active: input.active, head: input.body, band: [], foot: [] }, width).lines;
}
