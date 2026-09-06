import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG, loadGlobalTasksConfig } from "../src/config/tasks-config.ts";
import { DISPLAY_SETTING_ITEMS, openSettingsMenu } from "../src/ui/settings-menu.ts";
import { plainTheme } from "./helpers.ts";

initTheme();

function fixture(t: TestContext) {
	const agent = mkdtempSync(join(tmpdir(), "task-settings-"));
	t.after(() => rmSync(agent, { recursive: true, force: true }));
	return { agent, path: join(agent, "tasks-config.json") };
}

test("settings exposes only the five approved display rows with upstream copy", () => {
	assert.deepEqual(DISPLAY_SETTING_ITEMS.map((item) => item.label), [
		"Collapse completed tasks", "Show all tasks in widget", "Max visible tasks in widget", "Widget sort order", "Hidden tasks position",
	]);
	assert.match(DISPLAY_SETTING_ITEMS[0].description, /single 'N completed' line/);
	assert.match(DISPLAY_SETTING_ITEMS[3].description, /custom sort spec/);
});

test("SettingsList renders global scope, fits narrow widths, cycles all five rows and saves immediately", async (t) => {
	const f = fixture(t);
	const config = { ...DEFAULT_TASKS_CONFIG, glyphs: {} };
	let changed = 0;
	let done = false;
	const expectedValues = [true, true, 15, "status", "top"];
	const ui: any = {
		notify(message: string) { assert.fail(message); },
		custom: async (factory: any) => {
			const component = factory({}, plainTheme, {}, () => { done = true; });
			const wide = component.render(100).join("\n");
			assert.match(wide, /⚙  Global Task Settings/);
			assert.match(wide, /Saved immediately for all projects/);
			assert.match(wide, /Other sessions pick up changes on start or \/reload/);
			assert.match(wide, /Collapse completed tasks/);
			for (const width of [80, 40, 20]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
			for (const [index, item] of DISPLAY_SETTING_ITEMS.entries()) {
				component.handleInput("\r");
				assert.equal(JSON.parse(readFileSync(f.path, "utf8"))[item.id], expectedValues[index]);
				assert.equal(changed, index + 1);
				component.handleInput("\u001b[B");
			}
			component.handleInput("\u001b");
		},
	};
	await openSettingsMenu(ui, config, () => { changed++; }, f.agent);
	assert.deepEqual(loadGlobalTasksConfig(f.agent), config);
	assert.equal(changed, 5);
	assert.equal(done, true);
	assert.deepEqual(readdirSync(f.agent), ["tasks-config.json"]);
});

for (const [index, item] of DISPLAY_SETTING_ITEMS.entries()) {
	test(`failed global save restores ${item.id} in config and SettingsList without applying changes`, async (t) => {
		const f = fixture(t);
		writeFileSync(f.path, "{ malformed\n");
		const config = { ...DEFAULT_TASKS_CONFIG, glyphs: {} };
		const notifications: Array<{ message: string; level: string }> = [];
		let changed = 0;
		const ui: any = {
			notify(message: string, level: string) { notifications.push({ message, level }); },
			custom: async (factory: any) => {
				const component = factory({}, plainTheme, {}, () => {});
				for (let i = 0; i < index; i++) component.handleInput("\u001b[B");
				const before = component.render(100);
				component.handleInput("\r");
				assert.deepEqual(component.render(100), before);
				component.handleInput("\u001b");
			},
		};
		await openSettingsMenu(ui, config, () => { changed++; }, f.agent);
		assert.deepEqual(config, DEFAULT_TASKS_CONFIG);
		assert.equal(changed, 0);
		assert.equal(readFileSync(f.path, "utf8"), "{ malformed\n");
		assert.equal(notifications.length, 1);
		assert.equal(notifications[0].level, "error");
		assert.match(notifications[0].message, /Could not save task settings: Error: Existing task config .* malformed JSON/);
	});
}

test("menu saves only the selected global field, preserving newer preferences and unknown keys", async (t) => {
	const f = fixture(t);
	const config = { ...DEFAULT_TASKS_CONFIG, glyphs: {} };
	const latest = { showAll: true, maxVisible: 50, sortOrder: "recent", glyphs: { pending: "P", futureGlyph: "keep" }, future: { keep: true } };
	writeFileSync(f.path, JSON.stringify(latest));
	const ui: any = {
		notify(message: string) { assert.fail(message); },
		custom: async (factory: any) => {
			const component = factory({}, plainTheme, {}, () => {});
			component.handleInput("\r");
			assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { ...latest, collapseCompleted: true });
			component.handleInput("\r");
			assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")), { ...latest, collapseCompleted: false });
			component.handleInput("\u001b");
		},
	};
	await openSettingsMenu(ui, config, () => {}, f.agent);
});

test("custom sort displays custom and cycles directly to id in the global file", async (t) => {
	const f = fixture(t);
	const config: any = { ...DEFAULT_TASKS_CONFIG, glyphs: {}, sortOrder: [{ field: "updatedAt", direction: "desc" }] };
	const ui: any = {
		notify(message: string) { assert.fail(message); },
		custom: async (factory: any) => {
			const component = factory({}, plainTheme, {}, () => {});
			component.handleInput("\u001b[B");
			component.handleInput("\u001b[B");
			component.handleInput("\u001b[B");
			assert.match(component.render(80).join("\n"), /custom/);
			component.handleInput("\r");
			component.handleInput("\u001b");
		},
	};
	await openSettingsMenu(ui, config, () => {}, f.agent);
	assert.equal(config.sortOrder, "id");
	assert.equal(loadGlobalTasksConfig(f.agent).sortOrder, "id");
});
