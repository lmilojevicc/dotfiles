import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { captureRootHome } from "./root-home.fixture.ts";

// Frozen from the original /context command's first overlay, before implementation changes.
// The file stores every raw ANSI line (not stripped/normalized output); tests never update it.
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./root-home.ansi.json", import.meta.url)), "utf8"));

test("/context root home retains historical ANSI except authorized heading, full-width columns and body padding", async () => {
	const actual = await captureRootHome();
	assert.deepEqual(actual.options, [{
		overlay: true,
		overlayOptions: { anchor: "center", width: 80, minWidth: 44, maxHeight: "90%", margin: 1 },
	}]);
	assert.deepEqual(golden.options[0].overlayOptions, { ...actual.options[0].overlayOptions, width: 64 });
	assert.deepEqual(actual.captures.map(({ width, state }) => [width, state]),
		[64, 44].flatMap((width) => ["initial", "selected-memory", "hover-memory", "hover-esc"].map((state) => [width, state])));
	for (const [index, capture] of actual.captures.entries()) {
		const expected = golden.captures[index];
		assert.equal(capture.lines.length, 21, `${capture.width} ${capture.state}: shared frame height`);
		for (const line of capture.lines) assert.equal(visibleWidth(line), capture.width);
		const header = capture.lines[5];
		assert.ok(header.includes(`\x1b[38;5;208m${" ".repeat(capture.width - 23)}Est. tokens  % window`));
		assert.doesNotMatch(header, /\x1b\[48;/, "heading has no selection/hover background");
		for (let n = 14; n < 18; n++) assert.equal(capture.lines[n], expected.lines[4], "only blank body padding added");
		const preserved = [...capture.lines.slice(0, 5), ...capture.lines.slice(6, 14), ...capture.lines.slice(18)];
		for (const [lineIndex, line] of preserved.entries()) {
			// Geometry only: token width 7→11, percentage width 6→8, and move the
			// remaining trailing space into the label column (historically 16 cells).
			// No ANSI stripping, recoloring, or golden regeneration is permitted.
			const labelExpansion = capture.width - 28 - 16;
			const original = expected.lines[lineIndex];
			const migrated = lineIndex >= 5 && lineIndex <= 12
				? original.replace(/(\d+(?:\.\d+)?k?)(  )( *\d+\.\d+%)( +)/,
					(_match: string, tokens: string, gap: string, percent: string, trailing: string) =>
						`${" ".repeat(4 + labelExpansion)}${tokens}${gap}  ${percent}${trailing.slice(6 + labelExpansion)}`)
				: original;
			assert.deepEqual(Buffer.from(line, "utf8"), Buffer.from(migrated, "utf8"),
				`${capture.width} ${capture.state}: historical ANSI line ${lineIndex}`);
		}
	}
});

test("/context root home fixture exercises semantic ANSI, bar, selection and hover", () => {
	for (const width of [64, 44]) {
		const find = (state: string) => golden.captures.find((entry: any) => entry.width === width && entry.state === state).lines as string[];
		const initial = find("initial");
		const selected = find("selected-memory");
		const hovered = find("hover-memory");
		const escHovered = find("hover-esc");
		assert.match(initial[0], /^\x1b\[38;5;202m╭/); // border
		assert.match(initial[1], /\x1b\[1m\x1b\[38;5;201mContext Usage/); // bold accent
		assert.match(initial[1], /\x1b\[38;5;203m\[esc\]/); // muted close button
		assert.match(escHovered[1], /\x1b\[38;5;209m\[esc\]/); // hover text
		assert.match(initial[5], /\x1b\[48;5;211m/); // selected background
		assert.match(selected[6], /\x1b\[48;5;211m/);
		assert.doesNotMatch(selected[5], /\x1b\[48;5;211m/);
		assert.match(hovered[6], /\x1b\[48;5;212m/); // distinct hover background
		assert.match(initial[14], /\x1b\[38;5;208m/); // dim footer
		for (const color of [201, 203, 204, 205, 206, 207, 208]) {
			assert.ok(initial[3].includes(`\x1b[38;5;${color}m█`), `${width}: colored bar segment ${color}`);
			assert.ok(initial.slice(5, 13).some((line) => line.includes(`\x1b[38;5;${color}m■`)),
				`${width}: semantic swatch ${color}`);
		}
	}
});
