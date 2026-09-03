import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_TASKS_CONFIG } from "../src/config/tasks-config.ts";
import { DISPLAY_SETTING_ITEMS, openSettingsMenu } from "../src/ui/settings-menu.ts";
import { plainTheme } from "./helpers.ts";

initTheme();

test("settings exposes only the five approved display rows with upstream copy", () => {
	assert.deepEqual(DISPLAY_SETTING_ITEMS.map((item) => item.label), [
		"Collapse completed tasks", "Show all tasks in widget", "Max visible tasks in widget", "Widget sort order", "Hidden tasks position",
	]);
	assert.match(DISPLAY_SETTING_ITEMS[0].description, /single 'N completed' line/);
	assert.match(DISPLAY_SETTING_ITEMS[3].description, /custom sort spec/);
});

test("SettingsList renders upstream title, fits narrow widths, cycles and saves immediately", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "task-settings-"));
	const config = { ...DEFAULT_TASKS_CONFIG, glyphs: {} };
	let changed = 0;
	let component: any;
	let done = false;
	const ui: any = {
		notify() {},
		custom: async (factory: any) => {
			component = factory({}, plainTheme, {}, () => { done = true; });
			const wide = component.render(80).join("\n");
			assert.match(wide, /⚙  Task Settings/);
			assert.match(wide, /Collapse completed tasks/);
			for (const width of [80, 40, 20]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
			component.handleInput("\r");
			component.handleInput("\u001b");
		},
	};
	await openSettingsMenu(ui, config, cwd, () => { changed++; });
	assert.equal(config.collapseCompleted, true);
	assert.equal(changed, 1);
	assert.equal(done, true);
});

test("save failures restore the setting and report the strict config error", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "task-settings-"));
	const projectConfig = join(cwd, ".pi", "tasks-config.json");
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(projectConfig, "{ malformed\n");
	const config = { ...DEFAULT_TASKS_CONFIG, glyphs: {} };
	const notifications: Array<{ message: string; level: string }> = [];
	let changed = 0;
	const ui: any = {
		notify(message: string, level: string) { notifications.push({ message, level }); },
		custom: async (factory: any) => {
			const component = factory({}, plainTheme, {}, () => {});
			component.handleInput("\r");
			component.handleInput("\u001b");
		},
	};
	await openSettingsMenu(ui, config, cwd, () => { changed++; });
	assert.equal(config.collapseCompleted, false);
	assert.equal(changed, 0);
	assert.equal(readFileSync(projectConfig, "utf8"), "{ malformed\n");
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "error");
	assert.match(notifications[0].message, /Could not save task settings: Error: Existing task config .* malformed JSON/);
});

test("custom sort displays custom and cycles directly to id", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "task-settings-"));
	const config: any = { ...DEFAULT_TASKS_CONFIG, glyphs: {}, sortOrder: [{ field: "updatedAt", direction: "desc" }] };
	const ui: any = {
		notify() {},
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
	await openSettingsMenu(ui, config, cwd, () => {});
	assert.equal(config.sortOrder, "id");
});
