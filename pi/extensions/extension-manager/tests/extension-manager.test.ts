import {
	getAgentDir,
	SettingsManager,
	type ExtensionCommandContext,
	type PackageSource,
	type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, test } from "node:test";
import { KeybindingsManager, type OverlayOptions, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import extensionManager, { SAVE_CHOICE, CANCEL_CHOICE } from "../index.ts";
import { applyExtensionChanges } from "../state.ts";

const agentDir = getAgentDir();

function resource(options: {
	path: string;
	enabled: boolean;
	origin?: "package" | "top-level";
	source?: string;
	baseDir?: string;
}): ResolvedResource {
	return {
		path: options.path,
		enabled: options.enabled,
		metadata: {
			source: options.source ?? "auto",
			scope: "user",
			origin: options.origin ?? "top-level",
			baseDir: options.baseDir ?? agentDir,
		},
	};
}

beforeEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(agentDir, { recursive: true });
});

test("top-level toggles preserve explicit discovery entries and unrelated filters", () => {
	const sample = resource({
		path: join(agentDir, "extensions", "sample", "index.ts"),
		enabled: true,
	});
	const update = applyExtensionChanges(
		["extensions/sample/index.ts", "!extensions/legacy/**"],
		[],
		[{ resource: sample, enabled: false }],
		agentDir,
	);

	assert.deepEqual(update.extensionPaths, [
		"extensions/sample/index.ts",
		"!extensions/legacy/**",
		"-extensions/sample/index.ts",
	]);
	assert.equal(update.extensionPathsChanged, true);
	assert.equal(update.packagesChanged, false);
});

test("top-level toggles normalize exact overrides and preserve broad exclusions", () => {
	const sample = resource({
		path: join(agentDir, "extensions", "sample", "index.ts"),
		enabled: false,
	});
	const update = applyExtensionChanges(
		["!extensions/**", "-./extensions/sample/index.ts"],
		[],
		[{ resource: sample, enabled: true }],
		agentDir,
	);

	assert.deepEqual(update.extensionPaths, [
		"!extensions/**",
		"+extensions/sample/index.ts",
	]);
});

test("package toggles use native filters and restore autoload when the last exclusion is removed", () => {
	const provider = resource({
		path: join(agentDir, "npm", "node_modules", "provider", "index.ts"),
		enabled: true,
		origin: "package",
		source: "npm:provider",
		baseDir: join(agentDir, "npm", "node_modules", "provider"),
	});
	const disabled = applyExtensionChanges(
		[],
		["npm:provider"],
		[{ resource: provider, enabled: false }],
		agentDir,
	);
	assert.deepEqual(disabled.packages, [{ source: "npm:provider", extensions: ["-index.ts"] }]);

	const enabled = applyExtensionChanges(
		[],
		disabled.packages,
		[{ resource: { ...provider, enabled: false }, enabled: true }],
		agentDir,
	);
	assert.deepEqual(enabled.packages, ["npm:provider"]);
});

test("package toggles normalize exact override paths and preserve exclusion filters", () => {
	const packageRoot = join(agentDir, "packages", "suite");
	const first = resource({
		path: join(packageRoot, "first.ts"),
		enabled: false,
		origin: "package",
		source: "npm:suite",
		baseDir: packageRoot,
	});
	const update = applyExtensionChanges(
		[],
		[{ source: "npm:suite", extensions: ["!*.ts", "-./first.ts"], skills: ["skills/review.md"] }],
		[{ resource: first, enabled: true }],
		agentDir,
	);

	assert.deepEqual(update.packages, [{
		source: "npm:suite",
		extensions: ["!*.ts", "+first.ts"],
		skills: ["skills/review.md"],
	}]);
});

test("autoload-disabled packages retain explicit enable overrides", () => {
	const packageRoot = join(agentDir, "packages", "suite");
	const first = resource({
		path: join(packageRoot, "first.ts"),
		enabled: false,
		origin: "package",
		source: "npm:suite",
		baseDir: packageRoot,
	});
	const update = applyExtensionChanges(
		[],
		[{ source: "npm:suite", autoload: false, extensions: ["-first.ts"] }],
		[{ resource: first, enabled: true }],
		agentDir,
	);

	assert.deepEqual(update.packages, [{
		source: "npm:suite",
		autoload: false,
		extensions: ["+first.ts"],
	}]);
});

test("enabling entries from an empty package filter does not enable every extension", () => {
	const packageRoot = join(agentDir, "packages", "suite");
	const first = resource({
		path: join(packageRoot, "first.ts"),
		enabled: false,
		origin: "package",
		source: "npm:suite",
		baseDir: packageRoot,
	});
	const second = resource({
		path: join(packageRoot, "second.ts"),
		enabled: false,
		origin: "package",
		source: "npm:suite",
		baseDir: packageRoot,
	});
	const packages: PackageSource[] = [{ source: "npm:suite", extensions: [], skills: ["skills/review.md"] }];
	const update = applyExtensionChanges(
		[],
		packages,
		[
			{ resource: first, enabled: true },
			{ resource: second, enabled: true },
		],
		agentDir,
	);

	assert.deepEqual(update.packages, [{
		source: "npm:suite",
		extensions: ["first.ts", "+second.ts"],
		skills: ["skills/review.md"],
	}]);
	assert.deepEqual(packages, [{ source: "npm:suite", extensions: [], skills: ["skills/review.md"] }]);
});

test("a stale package resource cannot be reported as saved", () => {
	const stale = resource({
		path: join(agentDir, "packages", "removed", "index.ts"),
		enabled: true,
		origin: "package",
		source: "npm:removed",
		baseDir: join(agentDir, "packages", "removed"),
	});

	assert.throws(
		() => applyExtensionChanges([], ["npm:other"], [{ resource: stale, enabled: false }], agentDir),
		/Package source is no longer configured globally: npm:removed/,
	);
});

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
	selections: Array<string | ((choices: string[]) => string | undefined)>,
	cwd = agentDir,
): Promise<{ reloadCount: number; notifications: string[]; titles: string[] }> {
	const command = registerExtensionCommand();
	let reloadCount = 0;
	const notifications: string[] = [];
	const titles: string[] = [];
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
			notify(message: string) {
				notifications.push(message);
			},
		},
		async reload() {
			reloadCount++;
		},
	} as unknown as ExtensionCommandContext;

	await command.handler("", ctx);
	return { reloadCount, notifications, titles };
}

type CapturedCustomOptions = {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
};

async function runTuiCommand(inputs: readonly string[]): Promise<{
	reloadCount: number;
	notifications: string[];
	customCount: number;
	selectCount: number;
	customOptions: CapturedCustomOptions | undefined;
	terminal: { rows: number; columns: number };
}> {
	const command = registerExtensionCommand();
	let reloadCount = 0, customCount = 0, selectCount = 0;
	let customOptions: CapturedCustomOptions | undefined;
	const notifications: string[] = [];
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
				component.render(renderWidth());
				for (const input of inputs) {
					component.handleInput(input);
					component.render(renderWidth());
				}
				return result;
			},
			async select() { selectCount++; return undefined; },
			notify(message: string) { notifications.push(message); },
		},
		async reload() { reloadCount++; },
	} as unknown as ExtensionCommandContext;
	await command.handler("", ctx);
	return { reloadCount, notifications, customCount, selectCount, customOptions, terminal: tui.terminal };
}

function writeExtension(name: string): void {
	const directory = join(agentDir, "extensions", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "index.ts"), "export default function () {}\n");
}

test("TUI passes centered 80%-responsive overlay sizing with a 96-column cap", async () => {
	writeExtension("first");
	const result = await runTuiCommand(["\x1b"]);
	assert.equal(result.customOptions?.overlay, true);

	const optionSource = result.customOptions?.overlayOptions;
	const options = typeof optionSource === "function" ? optionSource() : optionSource;
	assert.ok(options);
	assert.equal(options.width, 80);
	assert.equal(options.maxHeight, 19);
	assert.deepEqual(options.margin, { left: 1, right: 1 });
	assert.equal(options.anchor, "center");
	assert.equal(options.minWidth, undefined);

	result.terminal.columns = 160;
	assert.equal(options.width, 96);
	result.terminal.columns = 20;
	assert.equal(options.width, 16);
});

test("TUI saves staged toggles across single-result filters", async () => {
	writeExtension("aaaaaaaa");
	writeExtension("qqqqqqqq");
	writeFileSync(join(agentDir, "settings.json"), "{}");

	// Save directly from a filtered extension row without an action row.
	const inputs = ["aaaaaaaa", "\r", ...Array.from({ length: 8 }, () => "\x7f"), "qqqqqqqq", "\r", "s"];
	const result = await runTuiCommand(inputs);
	assert.equal(result.customCount, 1);
	assert.equal(result.selectCount, 0);
	assert.equal(result.reloadCount, 0, JSON.stringify(result));
	assert.deepEqual(result.notifications, ["Saved 2 extension changes; reload Pi for changes to take effect"]);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).extensions, [
		"-extensions/aaaaaaaa/index.ts",
		"-extensions/qqqqqqqq/index.ts",
	]);
});

test("TUI s on the last extension persists staged changes without runtime reload", async () => {
	writeExtension("first");
	const result = await runTuiCommand(["\r", "\x1b[B", "s"]);
	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).extensions, [
		"-extensions/first/index.ts",
	]);
	assert.equal(result.reloadCount, 0);
	assert.deepEqual(result.notifications, ["Saved 1 extension change; reload Pi for changes to take effect"]);
});

test("TUI save without staged changes is a no-op", async () => {
	writeExtension("first");
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, "{\"theme\":\"dark\"}\n");
	const result = await runTuiCommand(["s"]);
	assert.equal(readFileSync(settingsPath, "utf8"), "{\"theme\":\"dark\"}\n");
	assert.equal(result.reloadCount, 0);
	assert.deepEqual(result.notifications, ["No extension changes to save"]);
});

test("TUI cancel discards staged changes without saving or reloading", async () => {
	writeExtension("first");
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, "{\"theme\":\"dark\"}\n");
	const result = await runTuiCommand(["\r", "\x1b"]);
	assert.equal(result.reloadCount, 0);
	assert.equal(readFileSync(settingsPath, "utf8"), "{\"theme\":\"dark\"}\n");
	assert.ok(result.notifications.includes("Extension changes discarded"));
});

test("non-UI mode rejects the command instead of silently opening a custom UI", async () => {
	writeExtension("first");
	const command = registerExtensionCommand();
	const ctx = { cwd: agentDir, hasUI: false, mode: "json" } as unknown as ExtensionCommandContext;
	await assert.rejects(command.handler("", ctx), /\/extensions-manager requires interactive or RPC UI mode/);
});

test("the slash command stages multiple local toggles, saves them, and can re-enable them", async () => {
	writeExtension("first");
	writeExtension("second");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }, null, 2));

	const result = await runCommand([
		(choices) => choices.find((choice) => choice.includes("first/index.ts")),
		(choices) => choices.find((choice) => choice.includes("second/index.ts")),
		(choices) => {
			assert.ok(choices.includes(SAVE_CHOICE));
			return SAVE_CHOICE;
		},
	]);

	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, [
		"-extensions/first/index.ts",
		"-extensions/second/index.ts",
	]);
	assert.equal(settings.quietStartup, true);
	assert.equal(result.reloadCount, 0);
	assert.ok(result.titles.includes("Extensions (2 staged)"));
	assert.deepEqual(result.notifications, ["Saved 2 extension changes; reload Pi for changes to take effect"]);

	const enabled = await runCommand([
		(choices) => choices.find((choice) => choice.includes("first/index.ts")),
		(choices) => choices.find((choice) => choice.includes("second/index.ts")),
		SAVE_CHOICE,
	]);
	const enabledSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(enabledSettings.extensions, [
		"+extensions/first/index.ts",
		"+extensions/second/index.ts",
	]);
	assert.equal(enabledSettings.quietStartup, true);
	assert.equal(enabled.reloadCount, 0);
	assert.deepEqual(enabled.notifications, ["Saved 2 extension changes; reload Pi for changes to take effect"]);
});

test("RPC Save changes without staged changes is a no-op", async () => {
	writeExtension("first");
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, "{\"theme\":\"dark\"}\n");
	const result = await runCommand([SAVE_CHOICE]);
	assert.equal(readFileSync(settingsPath, "utf8"), "{\"theme\":\"dark\"}\n");
	assert.equal(result.reloadCount, 0);
	assert.deepEqual(result.notifications, ["No extension changes to save"]);
});

test("cancel discards all staged changes without writing or reloading", async () => {
	writeExtension("first");
	writeExtension("second");
	const originalSettings = `${JSON.stringify({ extensions: ["!extensions/legacy/**"] }, null, 2)}\n`;
	writeFileSync(join(agentDir, "settings.json"), originalSettings);

	const result = await runCommand([
		(choices) => choices.find((choice) => choice.includes("first/index.ts")),
		(choices) => choices.find((choice) => choice.includes("second/index.ts")),
		CANCEL_CHOICE,
	]);

	assert.equal(readFileSync(join(agentDir, "settings.json"), "utf8"), originalSettings);
	assert.equal(result.reloadCount, 0);
	assert.ok(result.notifications.includes("Extension changes discarded"));
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

	const result = await runCommand([
		(choices) => {
			assert.equal(choices.some((choice) => choice.includes("project-only")), false);
			return choices.find((choice) => choice.includes("global/index.ts"));
		},
		SAVE_CHOICE,
	], projectDir);

	assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).extensions, [
		"-extensions/global/index.ts",
	]);
	assert.equal(readFileSync(projectSettingsPath, "utf8"), projectSettings);
	assert.equal(result.reloadCount, 0);
});

for (const bytes of ["{ invalid json\n", "[]", "null", "\"scalar\"", "2", "true"]) {
	test(`invalid global settings root ${JSON.stringify(bytes)} is reported without being overwritten`, async () => {
		writeExtension("first");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, bytes);

		const result = await runCommand([]);

		assert.equal(readFileSync(settingsPath, "utf8"), bytes);
		assert.equal(result.reloadCount, 0);
		assert.ok(result.notifications.some((message) =>
			message.includes("Extension manager failed:"),
		));
	});
}

test("an empty global settings file follows native settings semantics", async () => {
	writeExtension("first");
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, "");

	const result = await runCommand([CANCEL_CHOICE]);

	assert.equal(readFileSync(settingsPath, "utf8"), "");
	assert.equal(result.reloadCount, 0);
});

test("a BOM-prefixed object is accepted during discovery without rewriting it", async () => {
	writeExtension("first");
	const settingsPath = join(agentDir, "settings.json");
	const bytes = "\uFEFF{\"theme\":\"dark\"}";
	writeFileSync(settingsPath, bytes);

	const result = await runCommand([CANCEL_CHOICE]);

	assert.equal(readFileSync(settingsPath, "utf8"), bytes);
	assert.equal(result.reloadCount, 0);
	assert.equal(result.titles[0], "Extensions (select to toggle)");
});

for (const bytes of ["[]", "null", "\"scalar\""]) {
	test(`invalid global root introduced before Save is preserved: ${bytes}`, async () => {
		writeExtension("first");
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, "{}");

		const result = await runCommand([
			(choices) => choices.find((choice) => choice.includes("first/index.ts")),
			() => {
				writeFileSync(settingsPath, bytes);
				return SAVE_CHOICE;
			},
		]);

		assert.equal(readFileSync(settingsPath, "utf8"), bytes);
		assert.equal(result.reloadCount, 0);
		assert.ok(result.notifications.some((message) =>
			message.includes("Global settings.json must contain a JSON object"),
		));
	});
}

test("a BOM-prefixed object introduced before Save is refreshed and merged", async () => {
	writeExtension("first");
	writeExtension("second");
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, "{}");

	const result = await runCommand([
		(choices) => choices.find((choice) => choice.includes("first/index.ts")),
		() => {
			writeFileSync(settingsPath, "\uFEFF{\"theme\":\"dark\",\"extensions\":[\"-extensions/second/index.ts\"]}");
			return SAVE_CHOICE;
		},
	]);

	const persisted = readFileSync(settingsPath, "utf8");
	assert.equal(persisted.startsWith("\uFEFF"), false);
	assert.deepEqual(JSON.parse(persisted), {
		theme: "dark",
		extensions: [
			"-extensions/second/index.ts",
			"-extensions/first/index.ts",
		],
	});
	assert.equal(result.reloadCount, 0);
});

test("a concurrent same-field edit is preserved when staged changes are saved", async () => {
	writeExtension("first");
	writeExtension("second");
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, "{}");

	const result = await runCommand([
		(choices) => choices.find((choice) => choice.includes("first/index.ts")),
		() => {
			writeFileSync(settingsPath, JSON.stringify({
				extensions: ["!extensions/legacy/**", "-extensions/second/index.ts"],
			}));
			return SAVE_CHOICE;
		},
	]);

	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).extensions, [
		"!extensions/legacy/**",
		"-extensions/second/index.ts",
		"-extensions/first/index.ts",
	]);
	assert.equal(result.reloadCount, 0);
});

test("a local-file package is visibly unavailable and cannot be toggled", async () => {
	const extensionPath = join(agentDir, "local-extension.ts");
	writeFileSync(extensionPath, "export default function () {}\n");
	const settingsPath = join(agentDir, "settings.json");
	const settingsBytes = JSON.stringify({ packages: ["./local-extension.ts"] });
	writeFileSync(settingsPath, settingsBytes);

	const result = await runCommand([
		(choices) => {
			const row = choices.find((choice) => choice.includes("local-extension.ts"));
			assert.match(row ?? "", /unavailable \(local file package\)/);
			return row;
		},
		CANCEL_CHOICE,
	]);

	assert.equal(readFileSync(settingsPath, "utf8"), settingsBytes);
	assert.equal(result.reloadCount, 0);
	assert.ok(result.notifications.some((message) =>
		message.includes("does not support extension filters for local-file packages"),
	));
});

test("the slash command can enable extensions omitted by an autoload-disabled package", async () => {
	const packageRoot = join(agentDir, "npm", "node_modules", "delta-suite");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(packageRoot, "first.ts"), "export default function () {}\n");
	writeFileSync(join(packageRoot, "second.ts"), "export default function () {}\n");
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
		name: "delta-suite",
		version: "1.0.0",
		pi: { extensions: ["./first.ts", "./second.ts"] },
	}));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: [{ source: "npm:delta-suite", autoload: false, extensions: [] }],
	}));

	const result = await runCommand([
		(choices) => {
			assert.ok(choices.some((choice) => choice.includes("npm:delta-suite · second.ts")));
			return choices.find((choice) => choice.includes("npm:delta-suite · first.ts"));
		},
		SAVE_CHOICE,
	]);

	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, [{
		source: "npm:delta-suite",
		autoload: false,
		extensions: ["+first.ts"],
	}]);
	assert.equal(result.reloadCount, 0);
});

test("the slash command disables and re-enables a package extension without uninstalling it", async () => {
	const packageRoot = join(agentDir, "npm", "node_modules", "suite");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(packageRoot, "first.ts"), "export default function () {}\n");
	writeFileSync(join(packageRoot, "second.ts"), "export default function () {}\n");
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
		name: "suite",
		version: "1.0.0",
		pi: { extensions: ["./first.ts", "./second.ts"] },
	}));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:suite"] }));

	const disabled = await runCommand([
		(choices) => choices.find((choice) => choice.includes("npm:suite · first.ts")),
		SAVE_CHOICE,
	]);
	let settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, [{ source: "npm:suite", extensions: ["-first.ts"] }]);
	assert.equal(disabled.reloadCount, 0);
	assert.equal(readFileSync(join(packageRoot, "first.ts"), "utf8"), "export default function () {}\n");

	const enabled = await runCommand([
		(choices) => choices.find((choice) => choice.includes("npm:suite · first.ts")),
		SAVE_CHOICE,
	]);
	settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.packages, ["npm:suite"]);
	assert.equal(enabled.reloadCount, 0);
});

test("a package removed while the menu is open is rejected without reload", async () => {
	const packageRoot = join(agentDir, "npm", "node_modules", "stale-suite");
	mkdirSync(packageRoot, { recursive: true });
	writeFileSync(join(packageRoot, "index.ts"), "export default function () {}\n");
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
		name: "stale-suite",
		version: "1.0.0",
		pi: { extensions: ["./index.ts"] },
	}));
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:stale-suite"] }));

	const result = await runCommand([
		(choices) => choices.find((choice) => choice.includes("npm:stale-suite · index.ts")),
		() => {
			writeFileSync(settingsPath, JSON.stringify({ packages: [] }));
			return SAVE_CHOICE;
		},
	]);

	assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { packages: [] });
	assert.equal(result.reloadCount, 0);
	assert.ok(result.notifications.some((message) =>
		message.includes("Package source is no longer configured globally: npm:stale-suite"),
	));
});

test("a persistence lock failure is surfaced and suppresses reload", async () => {
	writeExtension("first");
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, "{}");
	const originalSetExtensionPaths = SettingsManager.prototype.setExtensionPaths;

	const result = await (async () => {
		try {
			return await runCommand([
				(choices) => choices.find((choice) => choice.includes("first/index.ts")),
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

	assert.equal(readFileSync(settingsPath, "utf8"), "{}");
	assert.equal(result.reloadCount, 0);
	assert.ok(result.notifications.some((message) => /Could not save extension settings.*lock/i.test(message)));
});

test("a stale self-disable setting is repaired before saving", async () => {
	const managerDirectory = join(agentDir, "extensions", "extension-manager");
	mkdirSync(managerDirectory, { recursive: true });
	const managerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
	symlinkSync(managerPath, join(managerDirectory, "index.ts"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		extensions: ["-extensions/extension-manager/index.ts"],
	}));

	const result = await runCommand([SAVE_CHOICE]);
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings.extensions, ["+extensions/extension-manager/index.ts"]);
	assert.equal(result.reloadCount, 0);
	assert.equal(result.titles[0], "Extensions (1 staged)");
});
