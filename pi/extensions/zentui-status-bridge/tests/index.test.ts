import assert from "node:assert/strict";
import test from "node:test";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	type ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import zentuiStatusBridge from "../index.ts";
import { ZENTUI_CAPABILITY_EVENT, ZENTUI_VARIABLE_EVENT } from "../bridge.ts";

type Handler = ExtensionHandler<ExtensionEvent, unknown>;

function fakePi() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }>();
	const variables: Array<{ key: string; text: string | undefined }> = [];
	const pi = {
		events: {
			emit(channel: string, data: unknown) {
				if (channel === ZENTUI_CAPABILITY_EVENT) {
					const capability = data as { supported: boolean; active: boolean; version?: number };
					capability.supported = true;
					capability.active = true;
					capability.version = 1;
				}
				if (channel === ZENTUI_VARIABLE_EVENT) {
					variables.push(data as { key: string; text: string | undefined });
				}
			},
		},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> | void }) {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, commands, variables };
}

function fakeContext(mode: string) {
	const statuses: Array<[string, string | undefined]> = [];
	const notices: string[] = [];
	const ui = {
		setStatus(key: string, text: string | undefined) {
			statuses.push([key, text]);
		},
		notify(message: string) {
			notices.push(message);
		},
	};
	const ctx = { mode, hasUI: true, ui } as unknown as ExtensionContext;
	return { ctx, statuses, notices };
}

const fire = (handler: Handler | undefined, ctx: ExtensionContext) =>
	handler?.(undefined as never, ctx);

test("registers the tap events and the report command", () => {
	const { pi, handlers, commands } = fakePi();
	zentuiStatusBridge(pi);
	for (const event of ["session_start", "before_agent_start", "agent_end", "session_shutdown"]) {
		assert.ok(handlers.has(event), event);
	}
	assert.ok(commands.has("status-bridge"));
});

test("installs once per session and bridges a configured status in TUI mode", async () => {
	const { pi, handlers, variables } = fakePi();
	zentuiStatusBridge(pi);
	const { ctx, statuses } = fakeContext("tui");

	await fire(handlers.get("session_start"), ctx);
	await fire(handlers.get("before_agent_start"), ctx);
	await fire(handlers.get("agent_end"), ctx);

	// The tap forwards `pi-lens-lsp` (listed in the repository config) through the
	// bridge; the test agent dir has no config, so every key is bridged.
	ctx.ui.setStatus("pi-lens-lsp", "LSP Active: tsserver");
	ctx.ui.setStatus("other-extension", "42%");
	assert.deepEqual(variables, [
		{ key: "pi-lens-lsp", text: "LSP Active: tsserver" },
		{ key: "other-extension", text: "42%" },
	]);
	// Host copies removed because Zentui accepted them.
	assert.deepEqual(statuses, [
		["pi-lens-lsp", undefined],
		["other-extension", undefined],
	]);
});

test("does not tap outside TUI mode", async () => {
	const { pi, handlers, variables } = fakePi();
	zentuiStatusBridge(pi);
	const { ctx, statuses } = fakeContext("rpc");

	await fire(handlers.get("session_start"), ctx);
	await fire(handlers.get("before_agent_start"), ctx);
	ctx.ui.setStatus("pi-lens-lsp", "LSP Inactive");

	assert.deepEqual(variables, []);
	assert.deepEqual(statuses, [["pi-lens-lsp", "LSP Inactive"]]);
});

test("session_shutdown removes published values", async () => {
	const { pi, handlers, variables } = fakePi();
	zentuiStatusBridge(pi);
	const { ctx } = fakeContext("tui");
	await fire(handlers.get("session_start"), ctx);
	ctx.ui.setStatus("usage", "38%");
	await fire(handlers.get("session_shutdown"), ctx);
	assert.deepEqual(variables.at(-1), { key: "usage", text: undefined });
});

test("the report command describes the config and live keys", async () => {
	const { pi, handlers, commands } = fakePi();
	zentuiStatusBridge(pi);
	const { ctx, notices } = fakeContext("tui");
	await fire(handlers.get("session_start"), ctx);
	ctx.ui.setStatus("usage", "38%");

	await commands.get("status-bridge")?.handler("", ctx);
	const report = notices.join("\n");
	assert.match(report, /zentui-status-bridge\.json/);
	assert.match(report, /suppressHostStatus: true/);
	assert.match(report, /tap: installed/);
	assert.match(report, /published: usage → usage/);
});
