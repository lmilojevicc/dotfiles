import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { ModelPickerComponent } from "../component.ts";
import { favoriteKey } from "../favorites.ts";
import { keys, model, plainTheme } from "./fixtures.ts";

const down = "\x1b[B", up = "\x1b[A", pageDown = "\x1b[6~", pageUp = "\x1b[5~", tab = "\t", escape = "\x1b", toggle = "\x06";
const models = Array.from({ length: 60 }, (_, i) => model(i < 40 ? "alpha" : "beta", `model-${String(i).padStart(2, "0")}`));
function fixture(initial: string[] = [], current = models[0]) {
	let favorites = initial, fail = false, height = 20;
	const make = () => new ModelPickerComponent({ models, current, favorites, scoped: false, theme: plainTheme, keybindings: keys(),
		getHeight: () => height, onChange() {}, onCancel() {}, onSelect() {},
		onToggleFavorite: (item) => {
			if (fail) throw Error("read-only");
			const key = favoriteKey(item);
			favorites = favorites.includes(key) ? favorites.filter((value) => value !== key) : [...favorites, key];
			return favorites;
		},
	});
	const component = make();
	const paint = () => component.render(100).map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")));
	const press = (...input: string[]) => { for (const key of input) { component.handleInput(key); paint(); } };
	paint();
	return { component, make, paint, press, favorites: () => favorites, fail: () => { fail = true; }, external: (value: string[]) => { favorites = value; }, resize: (value: number) => { height = value; } };
}
function snapshot(lines: string[]) {
	const rows = lines.map((line, physical) => ({ line: line.split(" │ ").at(-1)!, physical })).filter(({ line }) => /model-\d+/.test(line));
	return { sequence: rows.map(({ line }) => line.replaceAll("★", " ")), top: rows[0]?.line.replaceAll("★", " "), selectedRow: rows.find(({ line }) => line.includes("❯"))?.physical, height: lines.length };
}
for (const scope of ["all", "provider"] as const) for (const query of ["", "mdl"] as const) {
	test(`stable ${scope} viewport: scrolled add/remove/readd and failed save, query=${query || "empty"}`, () => {
		const f = fixture([favoriteKey(models[2]), favoriteKey(models[3])]);
		if (scope === "provider") f.press(tab, down, down, tab);
		if (query) f.press(query); // actual fuzzy remainder, not a substring
		f.press(pageDown, pageDown, up, up);
		const selected = f.component.getSelectedModel();
		assert.ok(selected);
		const before = snapshot(f.paint());
		assert.doesNotMatch(before.top!, /model-0[0-3]/, "must exercise a scrolled viewport");
		for (const expected of [true, false, true]) {
			f.press(toggle);
			assert.equal(f.component.getSelectedModel(), selected);
			assert.deepEqual(snapshot(f.paint()), before, "sequence, physical highlight, top row and frame height all stay fixed");
			assert.equal(f.favorites().includes(favoriteKey(selected)), expected);
			assert.match(f.paint().join("\n"), new RegExp(`Favorites \\(${expected ? 3 : 2}\\)`));
			assert.equal(f.paint().find((line) => line.split(" │ ").at(-1)!.includes("❯"))!.includes("★"), expected);
		}
		f.fail(); f.press(toggle);
		assert.deepEqual(snapshot(f.paint()), before);
		assert.match(f.paint().join("\n"), /Favorites: read-only/);
		assert.equal(f.component.getQuery(), query);
		assert.deepEqual(f.component.getScope(), scope === "all" ? { kind: "all" } : { kind: "provider", provider: "alpha" });
	});
}

test("favorite sorting waits for actual query edit/clear, scope change or reopen, never pane/navigation keys", () => {
	const f = fixture();
	f.press(pageDown, pageDown, toggle);
	const chosen = f.component.getSelectedModel()!;
	const before = snapshot(f.paint());
	f.press(tab, pageUp, tab); // All clamped to All: not a scope change
	assert.deepEqual(snapshot(f.paint()), before);
	f.press(up, down, pageUp, pageDown);
	assert.deepEqual(snapshot(f.paint()), before);
	f.press("model");
	assert.match(snapshot(f.paint()).top!, new RegExp(chosen.id));
	f.press(escape);
	assert.match(snapshot(f.paint()).top!, new RegExp(chosen.id));
	// Remove/readd in place, then create another favorite below it.
	f.press(down, toggle);
	const second = f.component.getSelectedModel()!;
	f.press(up, toggle, toggle); // first favorite now last in stored order
	assert.match(snapshot(f.paint()).top!, new RegExp(chosen.id));
	f.press(tab, down, down, tab); // actual provider scope reprojects
	assert.match(snapshot(f.paint()).top!, new RegExp(second.id));
	const reopened = f.make();
	assert.equal(reopened.getSelectedModel(), second);
	assert.match(snapshot(reopened.render(100)).top!, new RegExp(second.id));
});

test("Favorites reconciles external membership in retained match order, retaining a surviving tuple", () => {
	const f = fixture(models.slice(0, 30).map(favoriteKey));
	f.press(tab, down, tab, pageDown, pageDown, up);
	const selected = f.component.getSelectedModel()!;
	// External reordering must not reorder retained rows; external removal of selected
	// makes this toggle re-add it, so its tuple remains selected.
	f.external(models.slice(0, 30).filter((item) => item !== selected && item !== models[0]).reverse().map(favoriteKey).concat(favoriteKey(models[35])));
	f.press(toggle);
	assert.equal(f.component.getSelectedModel(), selected);
	const sequence = snapshot(f.paint()).sequence.join("\n");
	const ids = [...sequence.matchAll(/model-(\d+)/g)].map((match) => Number(match[1]));
	assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
	assert.match(f.paint().join("\n"), /Favorites \(30\)/);
	f.press(pageDown);
	assert.equal(f.component.getSelectedModel(), models[35], "fresh member is reachable, not an invisible stale result");
});

test("Favorites middle/tail/last removal clamps viewport, keeps query/scope and supports further navigation", () => {
	const f = fixture(models.slice(0, 30).map(favoriteKey));
	f.press("mdl", tab, down, tab, pageDown, pageDown);
	const height = f.paint().length;
	const removedIndex = models.indexOf(f.component.getSelectedModel()!);
	f.press(toggle);
	assert.equal(f.component.getSelectedModel(), models[removedIndex + 1]);
	f.press(down, up);
	assert.equal(f.component.getSelectedModel(), models[removedIndex + 1]);
	f.press(pageDown); // tail
	assert.equal(f.component.getSelectedModel(), models[29]);
	f.press(toggle);
	assert.equal(f.component.getSelectedModel(), models[28]);
	assert.equal(f.paint().length, height);
	f.resize(12); f.paint();
	const pageRows = f.paint().filter((line) => /model-\d+/.test(line)).length;
	const previous = models.indexOf(f.component.getSelectedModel()!);
	f.press(pageUp);
	assert.equal(models.indexOf(f.component.getSelectedModel()!), previous - pageRows - Number(previous - pageRows <= removedIndex));
	while (f.component.getSelectedModel()) f.press(toggle);
	assert.equal(f.component.getQuery(), "mdl");
	assert.deepEqual(f.component.getScope(), { kind: "favorites" });
	assert.match(f.paint().join("\n"), /No favorites yet/);
	assert.match(f.paint().join("\n"), /Favorites \(0\)/);
	f.press(up, down, pageUp, pageDown, toggle, "\r");
	assert.equal(f.component.getSelectedModel(), undefined);
	assert.deepEqual(f.component.getScope(), { kind: "favorites" });
});

for (const scope of ["all", "provider"] as const) test(`${scope} external favorites refresh updates stars/count without moving retained rows`, () => {
	const f = fixture([favoriteKey(models[0]), favoriteKey(models[1])]);
	if (scope === "provider") f.press(tab, down, down, tab);
	f.press(pageDown, down);
	const selected = f.component.getSelectedModel()!;
	const before = snapshot(f.paint());
	f.external([favoriteKey(models[35]), favoriteKey(models[2])]);
	f.press(toggle);
	assert.deepEqual(snapshot(f.paint()), before);
	assert.deepEqual(f.favorites(), [favoriteKey(models[35]), favoriteKey(models[2]), favoriteKey(selected)]);
	assert.match(f.paint().join("\n"), /Favorites \(3\)/);
	assert.equal(f.component.getSelectedModel(), selected);
});

test("selected scope stays accented/bold when models focused, without a full-row selected background", () => {
	const styled: string[] = [];
	const component = new ModelPickerComponent({ models, scoped: false, keybindings: keys(), getHeight: () => 16,
		theme: { fg: (role, value) => { if (role === "accent") styled.push(value); return value; },
			bold: (value) => `<bold>${value}</bold>`, bg: () => { throw Error("no selected background"); } },
		onChange() {}, onCancel() {}, onSelect() {},
	});
	component.render(100);
	assert.equal(component.getPane(), "models");
	assert.ok(styled.includes("<bold>❯ All (60)</bold>"));
	assert.ok(styled.includes("❯"));
	assert.match(component.render(100).join("\n"), /<bold>alpha\/model-00<\/bold>/);
});
