import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { captureRootHome } from "./root-home.fixture.ts";

// Frozen from the original /context command's first overlay, before implementation changes.
// The file stores every raw ANSI line (not stripped/normalized output); tests never update it.
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./root-home.ansi.json", import.meta.url)), "utf8"));

test("/context root home overlay retains original ANSI render at 64 and 44 cells", async () => {
	const actual = await captureRootHome();
	assert.deepEqual(actual.options, [{
		overlay: true,
		overlayOptions: { anchor: "center", width: 64, minWidth: 44, maxHeight: "90%", margin: 1 },
	}]);
	assert.deepEqual(golden.options, actual.options);
	assert.deepEqual(actual.captures.map(({ width, state }) => [width, state]),
		[64, 44].flatMap((width) => ["initial", "selected-memory", "hover-memory", "hover-esc"].map((state) => [width, state])));
	for (const [index, capture] of actual.captures.entries()) {
		const expected = golden.captures[index];
		assert.equal(capture.lines.length, 16, `${capture.width} ${capture.state}: complete home panel`);
		for (const [lineIndex, line] of capture.lines.entries()) {
			assert.equal(visibleWidth(line), capture.width, `${capture.width} ${capture.state}: line ${lineIndex} width`);
			assert.deepEqual(Buffer.from(line, "utf8"), Buffer.from(expected.lines[lineIndex], "utf8"),
				`${capture.width} ${capture.state}: raw ANSI line ${lineIndex}`);
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
