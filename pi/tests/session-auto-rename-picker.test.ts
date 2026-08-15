import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const ENTER = "\r";
const ESCAPE = "\x1b";
const BACKSPACE = "\x7f";
const DELETE = "\x1b[3~";
const LEFT = "\x1b[D";

const entries = Array.from({ length: 24 }, (_, index) => ({
	provider: `provider-${index % 3}`,
	id: `model-${index.toString().padStart(2, "0")}`,
	name: `Display Model ${index}`,
}));

function fullId(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function plain(text: string): string {
	return text
		.replace(/\x1b_[\s\S]*?\x1b\\/gu, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "");
}

test("searchable picker scrolls, filters, cancels, and preserves model identity", async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-session-auto-rename-picker-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const configuredId = fullId(entries[18]);
	writeFileSync(join(agentDir, "session-auto-rename.json"), `${JSON.stringify({ model: configuredId })}\n`);

	try {
		const piExecutable = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
		const loaderUrl = pathToFileURL(join(dirname(piExecutable), "core/extensions/loader.js")).href;
		const { createExtensionRuntime, loadExtensions } = await import(loaderUrl);
		const runtime = createExtensionRuntime();
		const extensionPath = fileURLToPath(new URL("../extensions/session-auto-rename/index.ts", import.meta.url));
		const loaded = await loadExtensions([extensionPath], dirname(extensionPath), undefined, runtime);
		assert.deepEqual(loaded.errors, []);
		const command = loaded.extensions[0]?.commands.get("session-auto-rename");
		assert.ok(command);

		const notifications: string[] = [];
		let picker: any;
		let customCalls = 0;
		let refreshCalls = 0;
		const keybindings = {
			matches(data: string, id: string) {
				return data === ({
					"tui.select.up": UP,
					"tui.select.down": DOWN,
					"tui.select.pageUp": PAGE_UP,
					"tui.select.pageDown": PAGE_DOWN,
					"tui.select.confirm": ENTER,
					"tui.select.cancel": ESCAPE,
				} as Record<string, string>)[id];
			},
		};
		const theme = {
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			fg: (_color: string, text: string) => text,
		};
		const ctx = {
			hasUI: true,
			mode: "tui",
			model: entries[0],
			modelRegistry: {
				getAvailable: () => entries,
				getError: () => undefined,
				refresh: async () => {
					refreshCalls += 1;
					return { aborted: false, errors: new Map() };
				},
			},
			ui: {
				custom: (factory: Function) => new Promise((resolve) => {
					customCalls += 1;
					picker = factory({ requestRender() {} }, theme, keybindings, resolve);
				}),
				notify: (message: string) => notifications.push(message),
			},
		};
		const openPicker = async () => {
			picker = undefined;
			const pending = command.handler("", ctx as never);
			await new Promise((resolve) => setImmediate(resolve));
			assert.ok(picker, "custom picker opened");
			return { pending };
		};

		let { pending } = await openPicker();
		assert.equal(picker.getSelectedId(), configuredId);
		assert.ok(picker.getVisibleIds().includes(configuredId));
		assert.match(plain(picker.render(100).join("\n")), /→ .* \[configured\]/u);
		picker.handleInput(ESCAPE);
		await pending;
		assert.equal(JSON.parse(readFileSync(join(agentDir, "session-auto-rename.json"), "utf8")).model, configuredId);

		({ pending } = await openPicker());
		for (let index = 0; index < 16; index += 1) picker.handleInput(DOWN);
		assert.ok(picker.getVisibleIds().includes(picker.getSelectedId()));
		assert.equal(picker.getVisibleIds().length, 10);
		picker.handleInput(ESCAPE);
		await pending;

		({ pending } = await openPicker());
		const orderedIds = picker.getFilteredIds();
		while (picker.getSelectedId() !== orderedIds[5]) picker.handleInput(UP);
		picker.handleInput(PAGE_UP);
		assert.equal(picker.getSelectedId(), orderedIds[0]);
		assert.ok(picker.getVisibleIds().includes(orderedIds[0]));
		picker.handleInput(PAGE_UP);
		assert.equal(picker.getSelectedId(), orderedIds[0], "page up clamps at the first result");
		picker.handleInput(PAGE_DOWN);
		picker.handleInput(PAGE_DOWN);
		picker.handleInput(PAGE_DOWN);
		assert.equal(picker.getSelectedId(), orderedIds.at(-1));
		assert.ok(picker.getVisibleIds().includes(orderedIds.at(-1)));
		picker.handleInput(PAGE_DOWN);
		assert.equal(picker.getSelectedId(), orderedIds.at(-1), "page down clamps at the final result");
		picker.handleInput(ESCAPE);
		await pending;

		({ pending } = await openPicker());
		picker.handleInput("bc");
		picker.handleInput(HOME);
		picker.handleInput("a");
		picker.handleInput(END);
		picker.handleInput("d");
		assert.equal(picker.getQuery(), "abcd", "Home and End edit the search input instead of navigating the list");
		for (let index = 0; index < 4; index += 1) picker.handleInput(BACKSPACE);
		picker.handleInput("display 19");
		assert.deepEqual(picker.getFilteredIds(), [fullId(entries[19])]);
		picker.handleInput(LEFT);
		picker.handleInput(DELETE);
		assert.equal(picker.getQuery(), "display 1");
		assert.ok(picker.getFilteredIds().length > 1);
		picker.handleInput("9");
		picker.handleInput(BACKSPACE);
		assert.equal(picker.getQuery(), "display 1");
		for (let index = 0; index < "display 1".length; index += 1) picker.handleInput(BACKSPACE);
		assert.equal(picker.getQuery(), "");
		assert.equal(picker.getFilteredIds().length, entries.length);
		picker.handleInput("no-such-model");
		assert.deepEqual(picker.getFilteredIds(), []);
		assert.match(plain(picker.render(80).join("\n")), /No matching models/u);
		picker.handleInput(ESCAPE);
		await pending;

		const duplicateModels = [
			{ provider: "provider-a", id: "shared", name: "Shared A" },
			{ provider: "provider-b", id: "shared", name: "Shared B" },
		];
		ctx.modelRegistry.getAvailable = () => duplicateModels;
		({ pending } = await openPicker());
		picker.handleInput("provider-b/shared");
		for (const width of [1, 2, 5, 10]) {
			for (const line of picker.render(width)) assert.ok(plain(line).length <= width);
		}
		picker.handleInput(ENTER);
		await pending;
		assert.equal(JSON.parse(readFileSync(join(agentDir, "session-auto-rename.json"), "utf8")).model, "provider-b/shared");
		assert.match(notifications.at(-1) ?? "", /first prompt in a new \/new session/u);

		const callsBeforeRpc = customCalls;
		const refreshesBeforeRpc = refreshCalls;
		ctx.modelRegistry.getAvailable = () => [];
		await command.handler("", { ...ctx, mode: "rpc" } as never);
		assert.equal(customCalls, callsBeforeRpc, "non-TUI mode does not open the custom picker");
		assert.equal(refreshCalls, refreshesBeforeRpc, "argumentless non-TUI mode does not refresh models");
		assert.match(notifications.at(-1) ?? "", /explicit model: \/session-auto-rename provider\/model/u);
		assert.equal(JSON.parse(readFileSync(join(agentDir, "session-auto-rename.json"), "utf8")).model, "provider-b/shared");

		ctx.modelRegistry.getAvailable = () => duplicateModels;
		await command.handler("provider-a/shared", { ...ctx, mode: "rpc" } as never);
		assert.equal(JSON.parse(readFileSync(join(agentDir, "session-auto-rename.json"), "utf8")).model, "provider-a/shared");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
