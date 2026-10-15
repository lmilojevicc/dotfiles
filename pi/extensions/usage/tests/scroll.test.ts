import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UsageRow } from "../core.ts";
import {
	formatScrollFrame,
	formatUsageTableParts,
	frameHeight,
	scrollBand,
	type BandLine,
} from "../render.ts";
import { plain, theme, widths } from "./helpers.ts";

const now = Date.parse("2026-10-15T12:00:00Z");

function longRows(count: number): UsageRow[] {
	const rows: UsageRow[] = [];
	for (let index = 0; index < count; index += 1) {
		rows.push({
			group: `provider-${Math.floor(index / 3)}`,
			label: `account-${index}@example.com`,
			state: index % 4 === 0 ? "ok · priority 10" : "ok",
			windows: [
				{ label: "5h", usedPercent: (index * 7) % 101, resetsAt: now / 1000 + 3600 },
				{ label: "weekly", usedPercent: (index * 13) % 101, resetsAt: now / 1000 + 86_400 },
			],
		});
	}
	return rows;
}

function frameFor(count: number, width: number, height: number | undefined, offset = 0) {
	const table = formatUsageTableParts(theme, longRows(count), width, now);
	return formatScrollFrame(
		theme,
		{ titles: ["Codex", "OpenCode Go", "CLIProxyAPI"], active: 2, head: table.head, band: table.band, foot: [], height, offset },
		width,
	);
}

test("frameHeight keeps sane terminal sizes and falls back for absurd ones", () => {
	assert.equal(frameHeight(undefined), 24, "missing rows falls back");
	assert.equal(frameHeight(Number.NaN), 24, "NaN falls back");
	assert.equal(frameHeight(0), 24, "zero falls back");
	assert.equal(frameHeight(7), 24, "below the floor falls back");
	assert.equal(frameHeight(8), 8, "floor is accepted");
	assert.equal(frameHeight(40.6), 40, "fractional sizes floor");
	assert.equal(frameHeight(200), 200, "ceiling is accepted");
	assert.equal(frameHeight(201), 24, "above the ceiling falls back");
});

test("scrollBand windows the band, clamps both ends and never wraps", () => {
	const band: BandLine[] = Array.from({ length: 10 }, (_, index) => ({ line: `row-${index}` }));

	const fits = scrollBand(band, 0, 20);
	assert.equal(fits.offset, 0);
	assert.equal(fits.maxOffset, 0, "content that fits cannot scroll");
	assert.equal(fits.lines.length, 10, "all rows visible");
	assert.equal(fits.first, 0);
	assert.equal(fits.last, 9);

	const clampedLow = scrollBand(band, -5, 4);
	assert.equal(clampedLow.offset, 0, "cannot scroll above the first row");

	const atEnd = scrollBand(band, 999, 4);
	assert.equal(atEnd.offset, 6, "clamps to the start of the last full band");
	assert.deepEqual(atEnd.lines, ["row-6", "row-7", "row-8", "row-9"], "final rows stay reachable");
	assert.equal(atEnd.last, 9);

	const single = scrollBand(band, 3, 0);
	assert.equal(single.bandSize, 1, "band size never drops below one row");
	assert.equal(single.lines.length, 1);

	const fractional = scrollBand(band, 2.7, 3.9);
	assert.equal(fractional.offset, 2, "fractional offsets are floored");
	assert.equal(fractional.bandSize, 3, "fractional band sizes are floored");
});

test("scrollBand reports a governing heading as metadata without shrinking the window", () => {
	const band: BandLine[] = [
		{ line: "Heading A", heading: true },
		{ line: "a1" },
		{ line: "a2" },
		{ line: "Heading B", heading: true },
		{ line: "b1" },
		{ line: "b2" },
	];

	const midSection = scrollBand(band, 2, 2);
	assert.deepEqual(midSection.lines, ["a2", "Heading B"], "the window is exactly bandSize rows");
	assert.equal(midSection.bandSize, 2, "the band never shrinks to make room for a heading");
	assert.equal(midSection.offset, 2, "the requested offset survives");
	assert.equal(midSection.heading, "Heading A", "the governing section is reported for the title");

	const onHeading = scrollBand(band, 3, 2);
	assert.deepEqual(onHeading.lines, ["Heading B", "b1"], "rows scroll as a pure window");
	assert.equal(onHeading.heading, undefined, "a window starting on a heading needs no metadata");

	const headingScrolledPast = scrollBand(band, 5, 2);
	assert.deepEqual(headingScrolledPast.lines, ["b1", "b2"], "an offset past the end clamps to the last full band");
	assert.equal(headingScrolledPast.offset, 4, "the clamp is reported back to the caller");
	assert.equal(headingScrolledPast.heading, "Heading B", "the nearest preceding section is reported");

	const lastBand = scrollBand(band, band.length - 2, 2);
	assert.deepEqual(lastBand.lines, ["b1", "b2"], "the last full band keeps its rows");
	assert.equal(lastBand.offset, 4);
});

test("scrolling never collapses the page step, so paging keeps advancing", () => {
	const band: BandLine[] = [
		{ line: "Heading A", heading: true },
		...Array.from({ length: 30 }, (_, index) => ({ line: `a${index}` })),
		{ line: "Heading B", heading: true },
		...Array.from({ length: 5 }, (_, index) => ({ line: `b${index}` })),
	];
	const window = scrollBand(band, 1, 6);
	assert.equal(window.lines.length, 6, "a mid-section window keeps all six rows");
	assert.equal(window.bandSize, 6, "band size is unaffected by the heading metadata");
	assert.equal(window.heading, "Heading A", "context is not lost when the heading scrolls off");

	let offset = 0;
	const seen: number[] = [];
	while (offset < window.maxOffset) {
		const step = scrollBand(band, offset, window.bandSize);
		assert.equal(step.lines.length, window.bandSize, `full band at offset ${offset}`);
		offset = Math.min(offset + step.bandSize, step.maxOffset);
		seen.push(offset);
	}
	assert.ok(seen.length > 3, "paging covers the band in several steps");
	assert.equal(seen.at(-1), window.maxOffset, "paging reaches the end");
});

test("a short list renders the flat layout with no indicator and no scroll hints", () => {
	const shortRows: UsageRow[] = [
		{ label: "only-1", windows: [{ label: "5h", usedPercent: 8, resetsAt: now / 1000 + 3600 }], state: "ok" },
		{ label: "only-2", windows: [{ label: "weekly", usedPercent: 22 }], state: "ok" },
	];

	for (const width of widths) {
		const table = formatUsageTableParts(theme, shortRows, width, now);
		const flat = formatScrollFrame(
			theme,
			{ titles: ["Codex", "CLIProxyAPI"], active: 1, head: table.head, band: table.band, foot: [], height: undefined },
			width,
		);
		const tall = formatScrollFrame(
			theme,
			{ titles: ["Codex", "CLIProxyAPI"], active: 1, head: table.head, band: table.band, foot: [], height: 40 },
			width,
		);
		assert.equal(flat.overflow, false, "flat render cannot overflow");
		assert.equal(tall.overflow, false, "tall render cannot overflow");
		assert.deepEqual(tall.lines, flat.lines, `a fitting list renders identically at ${width} columns`);
		const text = plain(tall.lines).join("\n");
		assert.doesNotMatch(text, /rows \d+-\d+ of \d+/, "no range indicator when nothing scrolls");
		assert.doesNotMatch(text, /↑↓\/jk scroll/, "no scroll hints when nothing scrolls");
		assert.equal(tall.offset, 0);
		assert.equal(tall.maxOffset, 0);
	}
});

test("an overflowing band keeps the frame inside the terminal and reports its range", () => {
	const heights = [12, 14, 20, 24, 40, 60];
	for (const width of widths) {
		for (const height of heights) {
			const frame = frameFor(40, width, height);
			assert.equal(frame.overflow, true, `40 rows must overflow at ${height} rows`);
			assert.ok(
				frame.lines.length <= height,
				`${frame.lines.length} lines exceed the ${height}-row terminal at ${width} columns`,
			);
			for (const line of frame.lines) {
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width} at height ${height}`);
			}
			const text = plain(frame.lines).join("\n");
			assert.match(text, /rows 1-\d+ of \d+/, "range indicator starts at the first row");
			assert.match(text, /↑↓\/jk scroll|J\/K page/, "scroll hint is present");
			assert.match(text, /J\/K page/, "page hint is present");
			assert.match(text, /Esc close/, "close hint survives the scroll hints");
			assert.match(text, /CLIProxyAPI/, "the active tab stays visible");
			const total = Number(/of (\d+)/.exec(text)?.[1]);
			assert.ok(total > frame.bandSize, "the band is genuinely windowed");
		}
	}
});

test("paging advances by the band and stops at the last full band", () => {
	const width = 80;
	const height = 20;
	const first = frameFor(40, width, height, 0);
	const page = first.bandSize;

	const paged = frameFor(40, width, height, page);
	assert.equal(paged.offset, page, "one page advances by the band size");

	const last = frameFor(40, width, height, Number.POSITIVE_INFINITY);
	assert.equal(last.offset, last.maxOffset, "paging past the end stops at the last full band");
	const lastText = plain(last.lines).join("\n");
	assert.match(lastText, new RegExp(`rows ${last.maxOffset + 1}-${last.offset + last.bandSize} of `), "indicator follows the clamp");

	const back = frameFor(40, width, height, last.maxOffset - 1);
	assert.equal(back.offset, last.maxOffset - 1, "stepping back moves one row");

	const beyond = frameFor(40, width, height, last.maxOffset + 25);
	assert.equal(beyond.offset, last.maxOffset, "requests past the end clamp instead of blanking the band");
	assert.ok(beyond.lines.length <= height, "clamped frame still fits the terminal");
});

test("wide characters in labels never break the width contract", () => {
	const rows: UsageRow[] = Array.from({ length: 12 }, (_, index) => ({
		group: "プロバイダ",
		label: `アカウント-${index}@例え.jp`,
		windows: [{ label: "週間", usedPercent: index * 8, resetsAt: now / 1000 + 86_400 }],
	}));
	for (const width of widths) {
		const table = formatUsageTableParts(theme, rows, width, now);
		const frame = formatScrollFrame(
			theme,
			{ titles: ["Codex", "CLIProxyAPI"], active: 1, head: table.head, band: table.band, foot: [], height: 20 },
			width,
		);
		for (const line of frame.lines) {
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width} with wide characters`);
		}
	}
});

test("every rendered line is clamped to the width for a full-height band", () => {
	const frame = frameFor(40, 40, 24);
	assert.equal(frame.lines.length, 24, "a 24-row terminal yields exactly 24 lines");
	for (const line of frame.lines) {
		assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)} > 40`);
	}
	const stripped = frame.lines.map((line) => stripVTControlCharacters(line));
	assert.ok(stripped[0]!.length > 0, "top rule is rendered first");
	assert.ok(stripped.some((line) => line.includes("rows ")), "range indicator is inside the frame");
	assert.ok(stripped.at(-1)!.startsWith("─"), "bottom rule is last");
});

const LIVE_NOTES = [
	"  Skipped the hashed secret-key in ~/.cli-proxy-api/config.yaml.",
	"  Management key from ~/.cli-proxy-api/.management-password.",
	"  No API-key traffic recorded.",
	"  Normalized quota needs a CLIProxyAPI quota plugin.",
];

function frameWithNotes(rows: number, width: number, height: number | undefined) {
	const table = formatUsageTableParts(theme, longRows(rows), width, now);
	return formatScrollFrame(
		theme,
		{ titles: ["OpenCode Go", "CLIProxyAPI"], active: 1, head: table.head, band: table.band, foot: LIVE_NOTES, height },
		width,
	);
}

test("a short pane with notes stays inside the height and keeps the essentials", () => {
	for (const width of widths) {
		for (const height of [8, 9, 10, 12, 13, 15, 20]) {
			const frame = frameWithNotes(32, width, height);
			assert.ok(
				frame.lines.length <= height,
				`${frame.lines.length} lines exceed the ${height}-row pane at ${width} columns`,
			);
			for (const line of frame.lines) {
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width} at ${height} rows`);
			}
			const text = plain(frame.lines).join("\n");
			assert.match(text, /rows \d+-\d+ of \d+/, "range indicator survives a short pane");
			assert.match(text, /↑↓\/jk scroll|J\/K page/, "scroll hint survives a short pane");
			assert.match(text, /Esc close/, "close hint survives a short pane");
			assert.ok(plain([frame.lines.at(-1)!])[0]!.startsWith("─"), "bottom rule stays last");
			assert.ok(frame.bandSize >= 1, "the band never disappears");
		}
	}
});

test("rows outrank notes: a tight pane drops notes before shrinking the band", () => {
	const budget = 13; // a 15-row terminal minus STATUSLINE_RESERVE, as seen in the live run
	const frame = frameWithNotes(32, 120, budget);
	assert.equal(frame.lines.length, budget, "the frame uses the full available height");
	assert.ok(frame.bandSize >= 3, `band must stay usable, got ${frame.bandSize}`);
	const text = plain(frame.lines).join("\n");
	assert.equal(frame.bandSize >= 3, true, "the band keeps a comfortable size on a tight pane");
	assert.ok(text.includes("No API-key traffic recorded.") || text.includes("… +"), "dropped notes are either shown or disclosed");
	assert.ok(!/\n\s*\n\s*\n/.test(text), "no empty runs from dropped notes");
});

test("a roomy pane still shows every note and never exceeds its height", () => {
	for (const height of [22, 24, 30, 40]) {
		const frame = frameWithNotes(32, 120, height);
		assert.ok(frame.lines.length <= height, `${frame.lines.length} > ${height}`);
		const text = plain(frame.lines).join("\n");
		assert.ok(text.includes("Normalized quota needs a CLIProxyAPI quota plugin."), `notes shown at ${height} rows`);
		assert.doesNotMatch(plain([text]).join("\n"), /\+1 more|\+2 more|\+3 more/, "no marker when everything fits");
		assert.ok(frame.bandSize >= 3, `band stays comfortable at ${height} rows`);
	}
});

test("notes that do not fit are replaced by a marker rather than pushing the frame over", () => {
	// A 13-row budget leaves no room for any note, so the frame must disclose the omissions.
	const frame = frameWithNotes(32, 120, 13);
	assert.ok(frame.lines.length <= 13, `${frame.lines.length} > 13`);
	const text = plain(frame.lines).join("\n");
	assert.match(text, /… \+\d+ more/, "dropped notes are disclosed with a count");
	assert.ok(text.includes("rows "), "the band is still reported");
});


test("error and loading frames without a band still respect the height", () => {
	const head = [
		"  CLIProxyAPI · localhost:8317",
		"",
		"  Management API is off · set remote-management.secret-key",
		"  Press R to retry.",
	];
	for (const width of widths) {
		for (const height of [8, 9, 10, 12, 16, 24]) {
			const frame = formatScrollFrame(
				theme,
				{ titles: ["OpenCode Go", "CLIProxyAPI"], active: 1, head, band: [], foot: ["", "  Skipped the hashed secret-key."], height },
				width,
			);
			assert.ok(
				frame.lines.length <= height,
				`an empty-band frame rendered ${frame.lines.length} lines into ${height} rows at ${width} columns`,
			);
			for (const line of frame.lines) {
				assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
			}
			const text = plain(frame.lines).join("\n");
			assert.doesNotMatch(text, /rows \d+-\d+ of 0/, "an empty band is never described as a scrollable range");
			assert.equal(frame.overflow, false, "nothing to scroll means no overflow");
			if (height >= 12) assert.match(text, /Esc close/, "the way out survives on a short pane");
		}
	}
});

test("a short pane drops the column header before the title", () => {
	const title = "  CLIProxyAPI · localhost:8317";
	const headerRow = "  Item                           Window   Used";
	const head = [title, "", headerRow, "  ───────────────────"];
	const table = formatUsageTableParts(theme, longRows(24), 80, now);
	const frame = formatScrollFrame(
		theme,
		{ titles: ["OpenCode Go", "CLIProxyAPI"], active: 1, head, band: table.band, foot: [], height: 11 },
		80,
	);
	assert.ok(frame.lines.length <= 11, `${frame.lines.length} > 11`);
	const text = plain(frame.lines).join("\n");
	assert.ok(text.includes(title), "the snapshot title survives");
	assert.ok(!text.includes("Item"), "the column header is given up first");
	assert.ok(frame.bandSize >= 1, "the band survives");
});

test("the production foot shape (leading blank line) is handled", () => {
	const table = formatUsageTableParts(theme, longRows(32), 120, now);
	const foot = ["", ...LIVE_NOTES];
	for (const height of [13, 16, 20, 26]) {
		const frame = formatScrollFrame(
			theme,
			{ titles: ["OpenCode Go", "CLIProxyAPI"], active: 1, head: table.head, band: table.band, foot, height },
			120,
		);
		assert.ok(frame.lines.length <= height, `${frame.lines.length} > ${height} with the production foot shape`);
		const text = plain(frame.lines).join("\n");
		if (text.includes("… +")) assert.match(text, /… \+\d+ more/, "a marker reports the omitted notes honestly");
		assert.ok(!/\n\s*\n\s*\n/.test(text), "no empty runs from dropped notes");
	}
});

test("even a pathologically narrow pane keeps the exit hint inside the height", () => {
	const table = formatUsageTableParts(theme, longRows(20), 20, now);
	for (const height of [8, 9, 10]) {
		const frame = formatScrollFrame(
			theme,
			{ titles: ["Codex", "OpenCode Go", "CLIProxyAPI"], active: 2, head: table.head, band: table.band, foot: LIVE_NOTES, height },
			20,
		);
		assert.ok(frame.lines.length <= height, `${frame.lines.length} lines exceed ${height} rows`);
		for (const line of frame.lines) assert.ok(visibleWidth(line) <= 20, `${visibleWidth(line)} > 20`);
		assert.match(plain(frame.lines).join("\n"), /Esc close/, "the way out survives the last-resort clamp");
	}
});
