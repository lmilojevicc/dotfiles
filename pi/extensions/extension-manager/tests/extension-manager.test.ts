import {
	getAgentDir,
	SettingsManager,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { KeybindingsManager, type OverlayOptions, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import extensionManager, { SAVE_CHOICE, CANCEL_CHOICE, setConfigDirectoryForTesting } from "../index.ts";

const agentDir = getAgentDir();
// beforeEach wipes agentDir; refuse to run against the real one without tests/register-loader.mjs.
assert.ok(agentDir.startsWith(tmpdir()), `refusing to wipe non-temporary agent dir ${agentDir}; run npm test`);
const configDir = join(agentDir, "config");
const configPath = join(configDir, "extension-manager.json");
const settingsPath = join(agentDir, "settings.json");

beforeEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(configDir, { recursive: true });
	setConfigDirectoryForTesting(configDir);
});

function readConfig(): { packages: Record<string, string>; extensions: Record<string, string> } | undefined {
	try {
		return JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		return undefined;
	}
}

function writeConfig(config: { packages?: Record<string, string>; extensions?: Record<string, string> }): void {
	writeFileSync(configPath, `${JSON.stringify({ packages: {}, extensions: {}, ...config }, null, 2)}\n`);
}

function readSettings(): Record<string, any> {
	return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function writeSettings(settings: unknown): string {
	const bytes = `${JSON.stringify(settings, null, 2)}\n`;
	writeFileSync(settingsPath, bytes);
	return bytes;
}

function writeExtension(name: string): void {
	const directory = join(agentDir, "extensions", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "index.ts"), "export default function () {}\n");
}

/** An installed package with one entrypoint, so discovery can see it and find its install. */
function writePackage(source: string): void {
	const root = join(agentDir, "npm", "node_modules", source.replace(/^npm:/, ""));
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({
		name: source.replace(/^npm:/, ""),
		version: "1.0.0",
		pi: { extensions: ["./index.js"] },
	}));
	writeFileSync(join(root, "index.js"), "export default function () {}\n");
}

const baseExtensions = ["extensions/extension-manager/loader.ts", "-builtin:mcp"];

type RegisteredCommand = {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
};

function registerExtensionCommand(): RegisteredCommand {
	let command: RegisteredCommand | undefined;
	extensionManager({
		registerCommand(name: string, value: RegisteredCommand) {
			assert.equal(name, "extensions-manager");
			command = value;
		},
	} as never);
	assert.ok(command);
	return command;
}

async function runCommand(
	selections: Array<string | undefined | ((choices: string[]) => string | undefined)>,
	cwd = agentDir,
	confirmations: boolean[] = [],
	args = "",
): Promise<{ notifications: string[]; titles: string[]; prompts: string[] }> {
	const command = registerExtensionCommand();
	const notifications: string[] = [];
	const titles: string[] = [];
	const prompts: string[] = [];
	const ctx = {
		cwd,
		hasUI: true,
		mode: "rpc",
		ui: {
			async select(title: string, choices: string[]) {
				titles.push(title);
				const selection = selections.shift();
				return typeof selection === "function" ? selection(choices) : selection;
			},
			async confirm(title: string, message: string) {
				prompts.push(`${title}: ${message}`);
				const answer = confirmations.shift();
				assert.notEqual(answer, undefined, "unexpected discard confirmation");
				return answer;
			},
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;

	await command.handler(args, ctx);
	return { notifications, titles, prompts };
}

type CapturedCustomOptions = {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
};

async function runTuiCommand(inputs: readonly string[]): Promise<{
	notifications: string[];
	customCount: number;
	selectCount: number;
	customOptions: CapturedCustomOptions | undefined;
	terminal: { rows: number; columns: number };
	frames: string[];
}> {
	const command = registerExtensionCommand();
	let customCount = 0, selectCount = 0;
	let customOptions: CapturedCustomOptions | undefined;
	const notifications: string[] = [];
	const frames: string[] = [];
	const theme = {
		fg: (_color: string, value: string) => value,
		bold: (value: string) => value,
	};
	const tui = { terminal: { rows: 24, columns: 100 }, requestRender() {} };
	const ctx = {
		cwd: agentDir,
		hasUI: true,
		mode: "tui",
		ui: {
			async custom(factory: Function, options: CapturedCustomOptions) {
				customCount++;
				customOptions = options;
				let result: unknown;
				const component = await factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), (value: unknown) => { result = value; });
				const renderWidth = () => {
					const overlayOptions = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
					const width = overlayOptions?.width;
					if (typeof width === "number") return width;
					if (typeof width === "string") return Math.floor(tui.terminal.columns * Number.parseFloat(width) / 100);
					return tui.terminal.columns;
				};
				component.focused = true;
				frames.push(component.render(renderWidth()).join("\n"));
				for (const input of inputs) {
					component.handleInput(input);
					frames.push(component.render(renderWidth()).join("\n"));
				}
				return result;
			},
			async select() { selectCount++; return undefined; },
			notify(message: string) { notifications.push(message); },
		},
	} as unknown as ExtensionCommandContext;
	await command.handler("", ctx);
	return { notifications, customCount, selectCount, customOptions, terminal: tui.terminal, frames };
}

/** RPC choice lookup by row label; both scopes are reachable through the switch action. */
function choose(labelPart: string) {
	return (choices: string[]) => {
		const choice = choices.find((candidate) => candidate.includes(labelPart) && !candidate.startsWith("Switch"));
		assert.notEqual(choice, undefined, `no choice for ${labelPart}: ${JSON.stringify(choices)}`);
		return choice;
	};
}

function chooseSwitch(choices: string[]): string | undefined {
	const choice = choices.find((candidate) => candidate.startsWith("Switch to"));
	assert.notEqual(choice, undefined, JSON.stringify(choices));
	return choice;
}

test("TUI passes centered 80%-responsive overlay sizing with a 96-column cap", async () => {
	writeExtension("first");
	writeSettings({ extensions: baseExtensions });
	const result = await runTuiCommand(["\x1b"]);
	assert.equal(result.customOptions?.overlay, true);

	const optionSource = result.customOptions?.overlayOptions;
	const options = typeof optionSource === "function" ? optionSource() : optionSource;
	assert.ok(options);
	assert.equal(options.width, 80);
	assert.equal(options.maxHeight, 19);
	assert.deepEqual(options.margin, { left: 1, right: 1 });
	assert.equal(options.anchor, "center");

	result.terminal.columns = 160;
	assert.equal(options.width, 96);
	result.terminal.columns = 20;
	assert.equal(options.width, 16);
});

test("disabling a package moves the plain string out of settings and into the tracked config", async () => {
	writePackage("npm:alpha");
	writePackage("npm:beta");
	const settingsBytes = writeSettings({
		theme: "dark",
		packages: ["npm:alpha", "npm:beta"],
		extensions: baseExtensions,
	});

	const result = await runTuiCommand(["npm:beta", "\r", "\x13"]);

	assert.equal(result.customCount, 1);
	assert.deepEqual(readSettings().packages, ["npm:alpha"]);
	assert.deepEqual(readConfig(), { packages: { "npm:beta": "global" }, extensions: {} });
	assert.deepEqual(result.notifications, ["Saved 1 extension change; reload Pi for changes to take effect"]);
	assert.deepEqual(readSettings(), { theme: "dark", packages: ["npm:alpha"], extensions: baseExtensions });
	assert.equal(readFileSync(settingsPath, "utf8").length < settingsBytes.length, true);
});

test("the BB tab disables a package only inside BB", async () => {
	writePackage("npm:alpha");
	writePackage("npm:beta");
	writeSettings({ packages: ["npm:alpha", "npm:beta"], extensions: baseExtensions });

	const result = await runTuiCommand(["\t", "npm:beta", "\r", "\x13"]);

	assert.match(result.frames[2], /Pi \(global\) │ BB/);
	assert.deepEqual(readSettings().packages, ["npm:alpha"]);
	assert.deepEqual(readConfig(), { packages: { "npm:beta": "bb" }, extensions: {} });
});

test("enabling a bb-owned package everywhere appends a plain string again", async () => {
	writePackage("npm:alpha");
	writePackage("npm:beta");
	writeSettings({ packages: ["npm:alpha"], extensions: baseExtensions });
	writeConfig({ packages: { "npm:beta": "bb" } });

	const result = await runTuiCommand(["\t", "npm:beta", "\r", "\x13"]);

	assert.deepEqual(readSettings().packages, ["npm:alpha", "npm:beta"]);
	assert.deepEqual(readConfig(), { packages: {}, extensions: {} });
	assert.deepEqual(result.notifications, ["Saved 1 extension change; reload Pi for changes to take effect"]);
});

test("switching an owned package between global and bb only edits the tracked config", async () => {
	writePackage("npm:beta");
	const settingsBytes = writeSettings({ packages: [], extensions: baseExtensions });
	writeConfig({ packages: { "npm:beta": "bb" } });

	const result = await runTuiCommand(["\r", "\x13"]);

	assert.deepEqual(readConfig(), { packages: { "npm:beta": "global" }, extensions: {} });
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes, "settings.json must stay byte-identical");
	assert.deepEqual(result.notifications, ["Saved 1 extension change; reload Pi for changes to take effect"]);
});

test("disabling a local extension adds exactly one -path line and re-enabling removes it", async () => {
	writeExtension("first");
	writeSettings({ extensions: [...baseExtensions, "-extensions/other/index.ts"] });

	await runTuiCommand(["extensions/first", "\r", "\x13"]);
	assert.deepEqual(readSettings().extensions, [
		...baseExtensions,
		"-extensions/other/index.ts",
		"-extensions/first/index.ts",
	]);
	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/first/index.ts": "global" } });

	const config = readConfig();
	writeSettings({ extensions: [...baseExtensions, "-./extensions/first/index.ts"] });
	writeConfig(config);
	await runTuiCommand(["extensions/first", "\r", "\x13"]);
	assert.deepEqual(readSettings().extensions, baseExtensions);
	assert.deepEqual(readConfig(), { packages: {}, extensions: {} });
});

test("a bb-disabled local extension keeps the same -path line and records the bb scope", async () => {
	writeExtension("first");
	writeSettings({ extensions: baseExtensions });

	await runTuiCommand(["\t", "extensions/first", "\r", "\x13"]);
	assert.deepEqual(readSettings().extensions, [...baseExtensions, "-extensions/first/index.ts"]);
	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/first/index.ts": "bb" } });
});

test("both tabs stage independently and save together", async () => {
	writePackage("npm:beta");
	writeExtension("first");
	writeSettings({ packages: ["npm:beta"], extensions: baseExtensions });

	// Global first off, Tab to BB, beta off there, save from the BB scope.
	const result = await runTuiCommand(["extensions/first", "\r", "\t", "\x15", "npm:beta", "\r", "\x13"]);

	assert.match(result.frames[2], /Extensions \(1 staged\)/);
	assert.deepEqual(readSettings().packages, []);
	assert.deepEqual(readSettings().extensions, [...baseExtensions, "-extensions/first/index.ts"]);
	assert.deepEqual(readConfig(), {
		packages: { "npm:beta": "bb" },
		extensions: { "extensions/first/index.ts": "global" },
	});
	assert.deepEqual(result.notifications.slice(0, 1), ["Saved 2 extension changes; reload Pi for changes to take effect"]);
});

test("the BB tab shows globally disabled rows as unavailable", async () => {
	writeExtension("alpha");
	writeExtension("beta");
	writeSettings({ extensions: [...baseExtensions, "-extensions/alpha/index.ts"] });
	writeConfig({ extensions: { "extensions/alpha/index.ts": "global" } });

	const result = await runTuiCommand(["\t", "\r", "\x1b"]);
	assert.match(result.frames[1], /Pi \(global\) │ BB/);
	assert.match(result.frames[2], /\[ \] extensions\/alpha\/index\.ts · off globally/);
	assert.ok(result.notifications.includes("This extension is disabled on the Pi (global) tab; enable it there before toggling the BB tab"));
	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/alpha/index.ts": "global" } });
});

test("a not-installed owned package is labelled and stays toggleable", async () => {
	writeSettings({ extensions: baseExtensions });
	writeConfig({ packages: { "npm:gone": "bb" } });

	const result = await runTuiCommand(["npm:gone", "\r", "\x13"]);
	assert.match(result.frames[0], /\[x\] npm:gone · not installed/);
	assert.deepEqual(readConfig(), { packages: { "npm:gone": "global" }, extensions: {} });
	assert.deepEqual(readSettings().extensions, baseExtensions);
});

test("TUI cancel discards staged changes without writing either file", async () => {
	writeExtension("first");
	const settingsBytes = writeSettings({ extensions: baseExtensions });
	const result = await runTuiCommand(["extensions/first", "\r", "\x1b", "\x1b[B", "\r"]);
	assert.ok(result.frames.some((frame) => /› Keep editing/.test(frame)));
	assert.ok(result.frames.some((frame) => /› Discard changes/.test(frame)));
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes);
	assert.equal(readConfig(), undefined);
	assert.ok(result.notifications.includes("Extension changes discarded"));
});

test("TUI clean cancel and toggled-back cancel exit without a confirmation", async () => {
	writeExtension("first");
	writeSettings({ extensions: baseExtensions });
	for (const inputs of [["\x1b"], ["\r", "\r", "\x1b"]]) {
		const result = await runTuiCommand(inputs);
		assert.ok(result.frames.every((frame) => !frame.includes("Discard changes")));
		assert.deepEqual(result.notifications, []);
		assert.equal(readConfig(), undefined);
	}
});

test("TUI keeps the filtered draft after declining discard and can still save it", async () => {
	writeExtension("first");
	writeExtension("second");
	writeSettings({ extensions: baseExtensions });
	const result = await runTuiCommand(["extensions/first", "\r", "\x1b", "\r", "\x13"]);
	assert.ok(result.frames.some((frame) => /› Keep editing/.test(frame)));
	const draft = result.frames.find((frame) => /Search: > extensions\/first/.test(frame) && /1 staged/.test(frame));
	assert.ok(draft, JSON.stringify(result.frames.at(-1)));
	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/first/index.ts": "global" } });
	assert.deepEqual(result.notifications, ["Saved 1 extension change; reload Pi for changes to take effect"]);
});

test("non-UI mode rejects the command instead of silently opening a custom UI", async () => {
	writeExtension("first");
	writeSettings({ extensions: baseExtensions });
	const command = registerExtensionCommand();
	const ctx = { cwd: agentDir, hasUI: false, mode: "json" } as unknown as ExtensionCommandContext;
	await assert.rejects(command.handler("", ctx), /\/extensions-manager requires interactive or RPC UI mode/);
});

test("RPC offers both scopes, moves entries, and never rewrites untouched settings", async () => {
	writePackage("npm:beta");
	writeExtension("first");
	writeSettings({ theme: "dark", packages: ["npm:beta"], extensions: baseExtensions });

	const result = await runCommand([
		choose("extensions/first"),
		chooseSwitch,
		choose("npm:beta"),
		(choices) => {
			assert.ok(choices.includes("Switch to Pi (global) scope"));
			return SAVE_CHOICE;
		},
	]);

	assert.equal(result.titles[0], "Extensions · Pi (global) (select to toggle)");
	assert.equal(result.titles[1], "Extensions · Pi (global) (1 staged)");
	assert.equal(result.titles[2], "Extensions · BB (1 staged)");
	assert.equal(result.titles[3], "Extensions · BB (2 staged)");
	assert.deepEqual(readSettings(), {
		theme: "dark",
		packages: [],
		extensions: [...baseExtensions, "-extensions/first/index.ts"],
	});
	assert.deepEqual(readConfig(), {
		packages: { "npm:beta": "bb" },
		extensions: { "extensions/first/index.ts": "global" },
	});
	assert.deepEqual(result.notifications.slice(0, 1), ["Saved 2 extension changes; reload Pi for changes to take effect"]);
});

test("RPC Save changes without staged changes is a no-op", async () => {
	writeExtension("first");
	const settingsBytes = writeSettings({ theme: "dark", extensions: baseExtensions });
	const result = await runCommand([SAVE_CHOICE]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes);
	assert.equal(readConfig(), undefined);
	assert.deepEqual(result.notifications, ["No extension changes to save"]);
});

test("RPC cancellation confirms only net changes, and No resumes the same draft", async () => {
	writeExtension("first");
	writeExtension("second");
	writeSettings({ extensions: baseExtensions });
	const clean = await runCommand([undefined]);
	assert.deepEqual(clean.prompts, []);

	const confirmed = await runCommand([choose("extensions/first"), CANCEL_CHOICE], agentDir, [true]);
	assert.equal(confirmed.prompts.length, 1);
	assert.deepEqual(confirmed.notifications, ["Extension changes discarded"]);
	assert.equal(readConfig(), undefined);

	const resumed = await runCommand([
		choose("extensions/first"),
		CANCEL_CHOICE,
		(titleChoices) => {
			assert.match(titleChoices.find((choice) => choice.includes("extensions/first/index.ts")) ?? "", /^\[ \]/);
			return SAVE_CHOICE;
		},
	], agentDir, [false]);
	assert.equal(resumed.prompts.length, 1);
	assert.ok(resumed.titles.includes("Extensions · Pi (global) (1 staged)"));
	assert.deepEqual(resumed.notifications, ["Saved 1 extension change; reload Pi for changes to take effect"]);
});

test("project-local resources and settings stay outside the global menu", async () => {
	writeExtension("global");
	const projectDir = join(agentDir, "project");
	const projectExtensionDir = join(projectDir, ".pi", "extensions", "project-only");
	mkdirSync(projectExtensionDir, { recursive: true });
	writeFileSync(join(projectExtensionDir, "index.ts"), "export default function () {}\n");
	const projectSettingsPath = join(projectDir, ".pi", "settings.json");
	const projectSettings = `${JSON.stringify({ extensions: ["!extensions/**"] }, null, 2)}\n`;
	writeFileSync(projectSettingsPath, projectSettings);
	writeSettings({ extensions: baseExtensions });

	const result = await runCommand([
		(choices) => {
			assert.equal(choices.some((choice) => choice.includes("project-only")), false);
			return choices.find((choice) => choice.includes("extensions/global"));
		},
		() => SAVE_CHOICE,
	], projectDir);

	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/global/index.ts": "global" } });
	assert.equal(readFileSync(projectSettingsPath, "utf8"), projectSettings);
});

test("a package settings lists again is reported as enabled and dropped by the next save", async () => {
	writePackage("npm:beta");
	writeExtension("first");
	writeSettings({ packages: ["npm:beta"], extensions: baseExtensions });
	writeConfig({ packages: { "npm:beta": "bb" } });

	const opened = await runCommand([
		chooseSwitch,
		(choices) => {
			// Pi loads it natively even inside BB, so both tabs must show it enabled.
			assert.match(choices.find((choice) => choice.includes("npm:beta")) ?? "", /^\[x\] npm:beta/);
			return CANCEL_CHOICE;
		},
	]);
	assert.ok(opened.notifications.includes(
		"npm:beta is listed in settings.json again, so it is enabled everywhere; saving removes its managed scope",
	));
	assert.deepEqual(readSettings().packages, ["npm:beta"], "opening the menu never writes settings");

	const saved = await runCommand([choose("extensions/first"), SAVE_CHOICE]);
	assert.deepEqual(readSettings().packages, ["npm:beta"], "it keeps loading natively from settings");
	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/first/index.ts": "global" } });
	assert.ok(saved.notifications.includes("Saved 1 extension change; reload Pi for changes to take effect"));
});

for (const bytes of ["{ invalid json\n", "[]", "null", "\"scalar\"", "2", "true"]) {
	test(`invalid global settings root ${JSON.stringify(bytes)} is reported without being overwritten`, async () => {
		writeExtension("first");
		writeFileSync(settingsPath, bytes);

		const result = await runCommand([]);

		assert.equal(readFileSync(settingsPath, "utf8"), bytes);
		assert.ok(result.notifications.some((message) => message.includes("Extension manager failed:")));
	});
}

test("an empty global settings file follows native settings semantics", async () => {
	writeExtension("first");
	writeFileSync(settingsPath, "");

	const result = await runCommand([CANCEL_CHOICE]);

	assert.equal(readFileSync(settingsPath, "utf8"), "");
	assert.equal(readConfig(), undefined);
});

test("a BOM-prefixed object is accepted during discovery without rewriting it", async () => {
	writeExtension("first");
	const bytes = "\uFEFF{\"theme\":\"dark\"}";
	writeFileSync(settingsPath, bytes);

	const result = await runCommand([CANCEL_CHOICE]);

	assert.equal(readFileSync(settingsPath, "utf8"), bytes);
	assert.equal(readConfig(), undefined);
});

test("the extension manager is listed as required and cannot be staged", async () => {
	const managerDirectory = join(agentDir, "extensions", "extension-manager");
	mkdirSync(managerDirectory, { recursive: true });
	symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), join(managerDirectory, "index.ts"));
	writeExtension("other");
	writeSettings({ extensions: baseExtensions });

	const result = await runCommand([
		(choices) => {
			const row = choices.find((choice) => choice.includes("extension-manager/index.ts"));
			assert.match(row ?? "", /^\[x\].*· required/);
			return row;
		},
		() => SAVE_CHOICE,
	]);

	assert.ok(result.notifications.some((message) => /keeps itself enabled/.test(message)));
	assert.equal(readConfig(), undefined);
	assert.deepEqual(readSettings().extensions, baseExtensions);
});

test("a stale config entry for the manager is removed by the next save", async () => {
	const managerDirectory = join(agentDir, "extensions", "extension-manager");
	mkdirSync(managerDirectory, { recursive: true });
	symlinkSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), join(managerDirectory, "index.ts"));
	writeExtension("other");
	writeSettings({ extensions: baseExtensions });
	writeConfig({ extensions: { "extensions/extension-manager/index.ts": "global" } });

	const result = await runCommand([choose("extensions/other"), () => SAVE_CHOICE]);

	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/other/index.ts": "global" } });
	assert.ok(result.notifications.some((message) => /removed it from the disabled lists/.test(message)));
});

test("unknown config ids survive a save and concurrent edits are not lost", async () => {
	writeExtension("first");
	writeSettings({ extensions: baseExtensions });
	writeConfig({ packages: { "npm:temporarily-removed": "global" } });

	await runCommand([
		choose("extensions/first"),
		() => {
			// A concurrent edit adds another id while the menu is open.
			writeConfig({ packages: { "npm:temporarily-removed": "global", "npm:added-later": "bb" } });
			return SAVE_CHOICE;
		},
	]);

	assert.deepEqual(readConfig(), {
		packages: { "npm:added-later": "bb", "npm:temporarily-removed": "global" },
		extensions: { "extensions/first/index.ts": "global" },
	});
});

test("a persistence lock failure is surfaced without writing the config", async () => {
	writeExtension("first");
	const settingsBytes = writeSettings({ extensions: baseExtensions });
	const originalSetExtensionPaths = SettingsManager.prototype.setExtensionPaths;

	const result = await (async () => {
		try {
			return await runCommand([
				choose("extensions/first"),
				() => {
					SettingsManager.prototype.setExtensionPaths = function (paths: string[]): void {
						originalSetExtensionPaths.call(this, paths);
						// The native setter has queued its write, but it has not run yet.
						mkdirSync(`${settingsPath}.lock`);
					};
					return SAVE_CHOICE;
				},
			]);
		} finally {
			SettingsManager.prototype.setExtensionPaths = originalSetExtensionPaths;
		}
	})();

	assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes);
	assert.equal(readConfig(), undefined, "the config must not claim a change settings refused");
	assert.ok(result.notifications.some((message) => /Could not save extension settings.*lock/i.test(message)));
});

test("an invalid settings root introduced before Save is preserved", async () => {
	writeExtension("first");
	writeSettings({ extensions: baseExtensions });

	const result = await runCommand([
		choose("extensions/first"),
		() => {
			writeFileSync(settingsPath, "[]");
			return SAVE_CHOICE;
		},
	]);

	assert.equal(readFileSync(settingsPath, "utf8"), "[]");
	assert.equal(readConfig(), undefined);
	assert.ok(result.notifications.some((message) => message.includes("Global settings.json must contain a JSON object")));
});

test("a package toggle still saves when settings.json disappears", async () => {
	writeExtension("first");
	writeSettings({ extensions: baseExtensions });
	rmSync(settingsPath);

	const result = await runCommand([choose("extensions/first"), SAVE_CHOICE]);

	assert.deepEqual(readConfig(), { packages: {}, extensions: { "extensions/first/index.ts": "global" } });
	assert.deepEqual(readSettings().extensions, ["-extensions/first/index.ts"]);
	assert.deepEqual(result.notifications.slice(0, 1), ["Saved 1 extension change; reload Pi for changes to take effect"]);
});

test("update refreshes owned packages through Pi's own update pass", async () => {
	// A pinned npm source is skipped by Pi's update pass, so the plumbing is testable offline.
	writeConfig({ packages: { "npm:pinned@1.0.0": "global" } });
	const settingsBytes = writeSettings({ packages: [], extensions: baseExtensions });

	const result = await runCommand([], agentDir, [], "update");

	assert.deepEqual(result.notifications, [
		"Updating 1 owned package...",
		"Updated 1 owned package; reload Pi to apply",
	]);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes);
	assert.deepEqual(readConfig(), { packages: { "npm:pinned@1.0.0": "global" }, extensions: {} });
});

test("update with nothing owned is a no-op", async () => {
	writeSettings({ extensions: baseExtensions });
	const result = await runCommand([], agentDir, [], "update");
	assert.deepEqual(result.notifications, ["No owned packages to update"]);
	assert.equal(readConfig(), undefined);
});

test("update rejects non-UI mode like the menu does", async () => {
	const command = registerExtensionCommand();
	const ctx = { cwd: agentDir, hasUI: false, mode: "json" } as unknown as ExtensionCommandContext;
	await assert.rejects(command.handler("update", ctx), /\/extensions-manager requires interactive or RPC UI mode/);
});
