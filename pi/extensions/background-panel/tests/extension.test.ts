/**
 * End to end through a real Pi session in TUI mode with bash-improved loaded: the faux model starts a
 * background command, the status counts it (setStatus count line), ↓ opens the panel on the Shell
 * tab, Enter shows the output and Ctrl+D kills it. bash-improved publishes over the
 * `background-jobs:v1` events, so the whole protocol path runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import bashImproved from "../../bash-improved/index.ts";
import backgroundPanel, { STATUS_KEY } from "../index.ts";

process.env.PI_BASH_WAIT_SECONDS ??= "1";

const KEY = { down: "\x1b[B", enter: "\r", escape: "\x1b", ctrlD: "\x04" };

interface Shown {
	component: { render(width: number): string[]; handleInput(data: string): void };
	overlay: boolean;
}

function fakeUi() {
	const statuses = new Map<string, string | undefined>();
	const inputs: Array<(data: string) => { consume: true } | undefined> = [];
	const shown: Shown[] = [];
	const notified: string[] = [];
	let editorText = "";
	const tui = {
		focusedComponent: { getText: () => editorText, setText: () => {} },
		requestRender: () => {},
		terminal: { rows: 30 },
	};
	const theme = {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};
	return {
		statuses,
		shown,
		notified,
		setEditorText: (text: string) => {
			editorText = text;
		},
		/** A key as the terminal sends it; returns whether an extension consumed it. */
		press(data: string): boolean {
			const top = shown.at(-1);
			if (top) {
				top.component.handleInput(data);
				return true;
			}
			return inputs.some((handler) => handler(data)?.consume);
		},
		ui: {
			theme,
			notify: (message: string) => notified.push(message),
			setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
			setWidget: (_key: string, content: unknown) => {
				if (typeof content === "function") content(tui, theme);
			},
			onTerminalInput: (handler: (data: string) => { consume: true } | undefined) => {
				inputs.push(handler);
				return () => inputs.splice(inputs.indexOf(handler), 1);
			},
			getEditorText: () => editorText,
			custom: (
				factory: (...args: unknown[]) => Shown["component"] & { dispose?(): void },
				options?: { overlay?: boolean },
			) =>
				new Promise((resolve) => {
					let entry: Shown;
					const component = factory(tui, theme, {}, (value: unknown) => {
						shown.splice(shown.indexOf(entry), 1);
						component.dispose?.();
						resolve(value);
					});
					entry = { component, overlay: options?.overlay === true };
					shown.push(entry);
				}),
		},
	};
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("↓ opens the panel on running shells; Enter shows output, Ctrl+D kills", async () => {
	const dir = mkdtempSync(join(tmpdir(), "session-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("bash", {
				command: "echo hello from the server; sleep 30",
				run_in_background: true,
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Started."),
	]);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		extensionFactories: [backgroundPanel, bashImproved],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
		tools: ["bash"],
	});
	const fake = fakeUi();
	await session.bindExtensions({ mode: "tui", uiContext: fake.ui as never });
	try {
		assert.equal(fake.statuses.get(STATUS_KEY), undefined);
		assert.equal(fake.press(KEY.down), false, "nothing to show yet: ↓ is left to the editor");

		await session.prompt("start the server");
		assert.equal(fake.statuses.get(STATUS_KEY), "↓ 1 shell");

		fake.setEditorText("draft");
		assert.equal(fake.press(KEY.down), false, "↓ in a non-empty editor is the editor's");
		fake.setEditorText("");
		assert.equal(fake.press(KEY.down), true);
		const panel = fake.shown[0];
		assert.equal(panel.overlay, false, "the panel takes the editor's place");
		const lines = panel.component.render(80).map((line) => line.trimEnd());
		assert.match(lines[1], /Shell +esc │$/);
		assert.match(lines[3], /echo hello from the server; sleep 30 +Running │$/);

		fake.press(KEY.enter);
		await until(() => fake.shown[0]?.overlay === true);
		await until(() =>
			fake.shown[0].component.render(80).some((line) => line.includes("hello from the server")),
		);
		const view = fake.shown[0].component.render(80);
		// A blank column outside each border keeps the chat behind away from it.
		assert.match(view[0], /^ ╭─+╮ $/);
		assert.match(view[1], /^ │ \$ echo hello from the server; sleep 30 +Running {2}esc │ $/);
		assert.match(view[2], /^ │ Shell output +│ $/);
		fake.press(KEY.escape);
		await until(() => fake.shown[0]?.overlay === false);

		fake.press(KEY.ctrlD);
		await until(() => fake.statuses.get(STATUS_KEY) === undefined);
		assert.ok(fake.notified.includes("Stopped task 1"));
		fake.press(KEY.escape);
		await until(() => fake.shown.length === 0);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	}
});
