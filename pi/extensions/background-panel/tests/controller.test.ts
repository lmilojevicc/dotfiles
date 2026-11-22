import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AnimationScheduler,
	BACKGROUND_JOBS_ACTION_TIMEOUT_MS,
	BackgroundPanelController,
	BACKGROUND_PANEL_CLOCK_MS,
	BACKGROUND_PANEL_STATUS_KEY,
} from "../controller.ts";
import {
	type BackgroundJob,
	type BackgroundJobsTab,
	BACKGROUND_JOBS_ACTION_EVENT,
	BACKGROUND_JOBS_ACTION_REPLY_EVENT,
	BACKGROUND_JOBS_CAPABILITY_EVENT,
	BACKGROUND_JOBS_PROTOCOL_VERSION,
	BACKGROUND_JOBS_SNAPSHOT_EVENT,
} from "../protocol.ts";
import { BackgroundJobsRegistry } from "../registry.ts";
import type { BackgroundPanelOpenKey } from "../config.ts";

const shellTab: BackgroundJobsTab = {
	id: "shell",
	label: "Shell",
	noun: ["shell", "shells"],
	order: 20,
};
const running: BackgroundJob = {
	id: "1",
	title: "npm run dev",
	status: "running",
	actions: { stop: "kill", output: true },
};

type Emitted = Array<{ channel: string; data: unknown }>;

function bus(): EventBus & { emitted: Emitted } {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const emitted: Emitted = [];
	return {
		emitted,
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel, data) {
			emitted.push({ channel, data });
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

interface Shown {
	component: {
		render(width: number): string[];
		handleInput(data: string): void;
		dispose?(): void;
	};
	options?: { overlay?: boolean };
}

interface FakeUi {
	ctx: ExtensionContext;
	statuses: Map<string, string | undefined>;
	statusCalls: Array<[string, string | undefined]>;
	widgetCalls: Array<[string, unknown]>;
	inputHandlers: Array<(data: string) => { consume: true } | undefined>;
	shown: Shown[];
	notifications: string[];
	press: (data: string) => boolean;
	setEditorText: (text: string) => void;
}

function fakeContext(editorText = "", options: { hasUI?: boolean } = {}): FakeUi {
	const statuses = new Map<string, string | undefined>();
	const statusCalls: Array<[string, string | undefined]> = [];
	const widgetCalls: Array<[string, unknown]> = [];
	const inputHandlers: Array<(data: string) => { consume: true } | undefined> = [];
	const shown: Shown[] = [];
	const notifications: string[] = [];
	let editor = editorText;
	const tui = {
		focusedComponent: {
			getText: () => editor,
			setText: () => {},
		},
		requestRender: () => {},
		terminal: { rows: 30 },
	};
	const theme = {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: "tui",
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				statusCalls.push([key, text]);
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			setWidget: (key: string, content: unknown) => {
				widgetCalls.push([key, content]);
				if (typeof content === "function")
					(content as (t: unknown, th: unknown) => unknown)(tui, theme);
			},
			onTerminalInput: (handler: (data: string) => { consume: true } | undefined) => {
				inputHandlers.push(handler);
				return () => {
					const at = inputHandlers.indexOf(handler);
					if (at >= 0) inputHandlers.splice(at, 1);
				};
			},
			getEditorText: () => editor,
			setEditorText: (value: string) => {
				editor = value;
			},
			notify: (message: string) => notifications.push(message),
			custom: (
				factory: (
					tui: unknown,
					theme: unknown,
					keys: unknown,
					done: (value: unknown) => void,
				) => Shown["component"],
				customOptions?: { overlay?: boolean },
			) =>
				new Promise((resolve) => {
					let entry: Shown | undefined;
					const component = factory(tui, theme, {}, (value: unknown) => {
						const at = entry ? shown.indexOf(entry) : -1;
						if (at >= 0) shown.splice(at, 1);
						component.dispose?.();
						resolve(value);
					});
					entry = { component, options: customOptions };
					shown.push(entry);
				}),
		},
	} as unknown as ExtensionContext;
	const press = (data: string) => {
		const top = shown.at(-1);
		if (top) {
			top.component.handleInput(data);
			return true;
		}
		return inputHandlers.some((handler) => handler(data)?.consume === true);
	};
	return {
		ctx,
		statuses,
		statusCalls,
		widgetCalls,
		inputHandlers,
		shown,
		notifications,
		press,
		setEditorText: (v: string) => {
			editor = v;
		},
	};
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

interface Setup {
	events: EventBus & { emitted: Emitted };
	registry: BackgroundJobsRegistry;
	controller: BackgroundPanelController;
	clock: FakeClock;
	fake: FakeUi;
	publish: (jobs: BackgroundJob[], tab?: BackgroundJobsTab) => void;
	setConfig: (next: Partial<RuntimeConfig>) => void;
	reply: (payload: Record<string, unknown>) => string;
}

type RuntimeConfig = {
	openKey: BackgroundPanelOpenKey;
	tabOrder: Record<string, number>;
	hideNativeWidgets: boolean;
};

interface FakeClock extends AnimationScheduler {
	/** Runs every scheduled handler once, advancing the wall clock by one frame. */
	tick: (steps?: number) => void;
	/** How many timers are currently scheduled. */
	running: () => number;
}

/** A scheduler whose ticks are driven by the test, so no test waits for real time. */
function fakeClock(): FakeClock {
	const handlers = new Set<() => void>();
	let now = 0;
	const clock: FakeClock = {
		now: () => now,
		every: (_ms: number, handler: () => void) => {
			handlers.add(handler);
			return {
				clear: () => {
					handlers.delete(handler);
				},
			};
		},
		tick: (steps = 1) => {
			for (let i = 0; i < steps; i += 1) {
				now += BACKGROUND_PANEL_CLOCK_MS;
				for (const handler of handlers) handler();
			}
		},
		running: () => handlers.size,
	};
	return clock;
}

function setup(
	options: {
		openKey?: BackgroundPanelOpenKey;
		hideNativeWidgets?: boolean;
		clock?: FakeClock;
	} = {},
): Setup {
	const events = bus();
	const registry = new BackgroundJobsRegistry();
	const clock = options.clock ?? fakeClock();
	let config: RuntimeConfig = {
		openKey: options.openKey ?? ("down" as const),
		tabOrder: {},
		hideNativeWidgets: options.hideNativeWidgets ?? true,
	};
	const controller = new BackgroundPanelController(events, registry, () => config, clock);
	const fake = fakeContext();
	return {
		clock,
		events,
		registry,
		controller,
		fake,
		publish: (jobs: BackgroundJob[], tab: BackgroundJobsTab = shellTab) =>
			events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
				version: BACKGROUND_JOBS_PROTOCOL_VERSION,
				source: "bash-improved",
				tab,
				jobs,
			}),
		setConfig: (next: Partial<RuntimeConfig>) => {
			config = { ...config, ...next };
		},
		/** Replies to the newest action request; returns the requestId. */
		reply: (payload: Record<string, unknown>) => {
			const request = [...events.emitted]
				.reverse()
				.find(
					({ channel, data }: { channel: string; data: unknown }) =>
						channel === BACKGROUND_JOBS_ACTION_EVENT && data,
				)?.data as {
				requestId: string;
			};
			if (!request) throw new Error("no action request was sent");
			events.emit(BACKGROUND_JOBS_ACTION_REPLY_EVENT, {
				requestId: request.requestId,
				...payload,
			});
			return request.requestId;
		},
	};
}

describe("background panel capability", () => {
	it("answers probes in place and announces once when a session starts", () => {
		const { events, controller, fake } = setup();
		const probe = { supported: false, active: false };
		events.emit(BACKGROUND_JOBS_CAPABILITY_EVENT, probe);
		assert.deepEqual(probe, { supported: true, active: false, version: 1 });
		const probeCount = events.emitted.length;
		controller.startSession(fake.ctx);
		const announcements = events.emitted
			.slice(probeCount)
			.filter(({ channel }: { channel: string }) => channel === BACKGROUND_JOBS_CAPABILITY_EVENT);
		assert.equal(announcements.length, 1);
		assert.deepEqual(announcements[0].data, { supported: true, active: true, version: 1 });
		const answered = { supported: false, active: false };
		events.emit(BACKGROUND_JOBS_CAPABILITY_EVENT, answered);
		assert.equal(answered.active, true);
	});

	it("ignores malformed capability probes without breaking dispatch", () => {
		const { events } = setup();
		assert.doesNotThrow(() => events.emit(BACKGROUND_JOBS_CAPABILITY_EVENT, "nope"));
		assert.doesNotThrow(() => events.emit(BACKGROUND_JOBS_CAPABILITY_EVENT, null));
	});
});

describe("background panel snapshots", () => {
	it("accepts snapshots only while a session runs and removes on empty or remove messages", () => {
		const { events, controller, fake, registry } = setup();
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "bash-improved",
			tab: shellTab,
			jobs: [running],
		});
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), undefined);
		controller.startSession(fake.ctx);
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "bash-improved",
			tab: shellTab,
			jobs: [running],
		});
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), "↓ 1 shell");
		// The last job ends: the count line clears.
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "bash-improved",
			tab: shellTab,
			jobs: [{ ...running, status: "done", endedAt: 1 }],
		});
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), undefined);
		// An empty snapshot removes the source entirely.
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "bash-improved",
			tab: shellTab,
			jobs: [],
		});
		assert.equal(registry.hasJobs(), false);
	});

	it("ignores invalid snapshots and never sets the status", () => {
		const { events, controller, fake } = setup();
		controller.startSession(fake.ctx);
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "x",
			tab: shellTab,
			jobs: [{}],
		});
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 2,
			source: "x",
			tab: shellTab,
			jobs: [running],
		});
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), undefined);
		assert.deepEqual(fake.statusCalls, []);
	});
});

describe("background panel status", () => {
	it("publishes the count line as the background-jobs status while jobs run", () => {
		const { events, controller, fake } = setup();
		controller.startSession(fake.ctx);
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "x",
			tab: shellTab,
			jobs: [running],
		});
		assert.deepEqual(fake.statusCalls.at(-1), [BACKGROUND_PANEL_STATUS_KEY, "↓ 1 shell"]);
		// Done jobs are not counted; the status clears.
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "x",
			tab: shellTab,
			jobs: [{ ...running, status: "done", endedAt: 1 }],
		});
		assert.deepEqual(fake.statusCalls.at(-1), [BACKGROUND_PANEL_STATUS_KEY, undefined]);
	});

	it("clears the status and handlers on shutdown", () => {
		const { events, controller, fake } = setup();
		controller.startSession(fake.ctx);
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: 1,
			source: "x",
			tab: shellTab,
			jobs: [running],
		});
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), "↓ 1 shell");
		assert.equal(fake.inputHandlers.length, 1);
		controller.shutdown();
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), undefined);
		assert.equal(fake.inputHandlers.length, 0);
		assert.equal(controller.isComponentActive(), false);
	});
});

describe("background panel key handling", () => {
	it("opens on the open key when the editor is empty, focused, and jobs exist", async () => {
		const { controller, fake, publish } = setup();
		controller.startSession(fake.ctx);
		assert.equal(fake.press("\x1b[B"), false);
		publish([running]);
		assert.equal(fake.press("k"), false);
		assert.equal(fake.press("\x1b[B"), true);
		await flush();
		assert.equal(fake.shown.length, 1);
		assert.equal(fake.shown[0]?.options?.overlay === true, false);
		assert.equal(
			fake.shown[0]?.component.render(80).some((line) => line.includes("npm run dev")),
			true,
		);
		fake.press("\x1b");
		await flush();
		assert.equal(fake.shown.length, 0);
	});

	it("leaves the key to the editor when it has text or the source is gone", () => {
		const { events, controller, fake, publish } = setup();
		controller.startSession(fake.ctx);
		publish([running]);
		fake.setEditorText("draft");
		assert.equal(fake.press("\x1b[B"), false);
		fake.setEditorText("");
		events.emit(BACKGROUND_JOBS_SNAPSHOT_EVENT, {
			version: BACKGROUND_JOBS_PROTOCOL_VERSION,
			source: "bash-improved",
			remove: true,
		});
		assert.equal(fake.press("\x1b[B"), false);
	});

	it("honors a configured open key", () => {
		const { controller, fake, publish } = setup({ openKey: "up" });
		controller.startSession(fake.ctx);
		publish([running]);
		assert.equal(fake.press("\x1b[B"), false);
		assert.equal(fake.press("\x1b[A"), true);
	});

	it("installs nothing outside a TUI session", () => {
		const { events, controller, fake, publish } = setup();
		const plain = fakeContext("", { hasUI: false });
		controller.startSession(plain.ctx);
		publish([running]);
		assert.equal(plain.inputHandlers.length, 0);
		assert.deepEqual(plain.statusCalls, []);
		assert.deepEqual(plain.widgetCalls, []);
		assert.equal(
			events.emitted.filter(
				({ channel }: { channel: string }) => channel === BACKGROUND_JOBS_CAPABILITY_EVENT,
			).length,
			0,
		);
		assert.equal(fake.press("\x1b[B"), false);
		assert.equal(controller.isComponentActive(), false);
	});
});

describe("background panel widgets", () => {
	it("hides replaced widgets and re-hides them on request", () => {
		const { controller, fake } = setup();
		controller.startSession(fake.ctx);
		const keys = fake.widgetCalls.map(([key]) => key);
		assert.ok(keys.includes("background-panel"));
		assert.ok(keys.includes("bg-sessions"));
		controller.suppressReplacedWidgets(fake.ctx);
		assert.equal(fake.widgetCalls.filter(([key]) => key === "bg-sessions").length, 2);
	});

	it("keeps replaced widgets when configured", () => {
		const { controller, fake } = setup({ hideNativeWidgets: false });
		controller.startSession(fake.ctx);
		const keys = fake.widgetCalls.map(([key]) => key);
		assert.ok(keys.includes("background-panel"));
		assert.equal(keys.includes("bg-sessions"), false);
	});
});

describe("background panel actions", () => {
	it("runs the stop action through the protocol and shows the panel again", async () => {
		const { events, controller, fake, publish, reply } = setup();
		controller.startSession(fake.ctx);
		publish([{ ...running, actions: { stop: "kill" } }]);
		fake.press("\x1b[B");
		await flush();
		fake.press("\x04"); // Ctrl+D
		const request = events.emitted.find(
			({ channel }: { channel: string }) => channel === BACKGROUND_JOBS_ACTION_EVENT,
		)?.data as { source: string; jobId: string; action: string };
		assert.equal(request?.source, "bash-improved");
		assert.equal(request?.jobId, "1");
		assert.equal(request?.action, "stop");
		reply({ ok: true });
		await flush();
		assert.deepEqual(fake.notifications, []);
		fake.press("\x1b");
		await flush();
		assert.equal(fake.shown.length, 0);
	});

	it("reports a failed stop action in the panel's notice row", async () => {
		const { controller, fake, publish, reply } = setup();
		controller.startSession(fake.ctx);
		publish([{ ...running, actions: { stop: "kill" } }]);
		fake.press("\x1b[B");
		await flush();
		fake.press("\x04");
		reply({ ok: false, error: "no such process" });
		await flush();
		assert.equal(
			fake.shown[0]?.component.render(80).some((line) => line.includes("Could not kill")),
			true,
		);
		fake.press("\x1b");
		await flush();
	});

	it("shows output, returns to the panel, and takes a job over on Enter", async () => {
		const { events, controller, fake, publish, reply } = setup();
		controller.startSession(fake.ctx);
		publish([
			{ ...running, actions: { open: "attach", output: true } },
			{ ...running, id: "2", title: "terminal session", actions: { output: true } },
		]);
		fake.press("\x1b[B");
		await flush();
		fake.press("\x0f"); // Ctrl+O: output even though open takes Enter
		await flush();
		assert.equal(fake.shown.at(-1)?.options?.overlay, true);
		reply({ ok: true, output: { heading: "$ npm run dev", text: "hello\nworld" } });
		await flush();
		const view = fake.shown.at(-1)?.component.render(80) ?? [];
		assert.equal(
			view.some((line) => line.includes("$ npm run dev")),
			true,
		);
		assert.equal(
			view.some((line) => line.includes("hello")),
			true,
		);
		assert.equal(
			view.some((line) => line.trim().includes("Shell output")),
			true,
		);
		fake.press("\x1b");
		await flush();
		// Back in the panel; Enter on the still-selected job takes it over.
		fake.press("\r");
		await flush();
		assert.equal(fake.shown.length, 0);
		const open = events.emitted.find(({ channel, data }: { channel: string; data: unknown }) => {
			const request = data as { action?: string };
			return channel === BACKGROUND_JOBS_ACTION_EVENT && request.action === "open";
		})?.data as { jobId: string };
		assert.equal(open.jobId, "1");
		reply({ ok: true });
		await flush();
		assert.deepEqual(fake.notifications, []);
	});

	it("times out an unanswered action and reports it", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { controller, fake, publish } = setup();
		controller.startSession(fake.ctx);
		publish([{ ...running, actions: { output: true } }]);
		fake.press("\x1b[B");
		t.mock.timers.tick(0);
		await flush();
		fake.press("\r");
		await flush();
		assert.equal(fake.shown.at(-1)?.options?.overlay, true);
		t.mock.timers.tick(BACKGROUND_JOBS_ACTION_TIMEOUT_MS + 10);
		await flush();
		const view = fake.shown.at(-1)?.component.render(80) ?? [];
		assert.equal(
			view.some((line) => line.includes("Could not read the output")),
			true,
		);
		// Esc from the output view goes back to the panel (it reopens); no error notification appears.
		fake.press("\x1b");
		await flush();
		assert.equal(fake.shown.at(-1)?.options?.overlay === true, false);
		assert.deepEqual(fake.notifications, []);
	});

	it("notifies when an open action fails", async () => {
		const { controller, fake, publish, reply } = setup();
		controller.startSession(fake.ctx);
		publish([{ ...running, actions: { open: "attach", output: true } }]);
		fake.press("\x1b[B");
		await flush();
		fake.press("\r");
		await flush();
		reply({ ok: false, error: "busy" });
		await flush();
		assert.deepEqual(fake.notifications, ["Could not attach: busy"]);
	});
});

describe("background panel lifecycle", () => {
	it("drops old-session wiring when a new session starts", () => {
		const { controller, publish } = setup();
		const first = fakeContext();
		controller.startSession(first.ctx);
		publish([running]);
		assert.equal(first.statuses.get(BACKGROUND_PANEL_STATUS_KEY), "↓ 1 shell");
		const second = fakeContext();
		controller.startSession(second.ctx);
		assert.equal(first.inputHandlers.length, 0);
		assert.equal(second.inputHandlers.length, 1);
		assert.equal(second.statuses.get(BACKGROUND_PANEL_STATUS_KEY), undefined);
	});
});

describe("background panel animation clock", () => {
	it("keeps the count line plain text and animates running rows only while the panel is open", async () => {
		const clock = fakeClock();
		const { controller, fake, publish } = setup({ clock });
		controller.startSession(fake.ctx);
		publish([running]);
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), "↓ 1 shell");
		assert.equal(clock.running(), 0, "nothing is animated while the panel is closed");
		const calls = fake.statusCalls.length;

		fake.press("\u001b[B");
		await flush();
		assert.equal(clock.running(), 1, "the open panel animates its running rows");
		const row = () => fake.shown[0].component.render(80)[3];
		assert.ok(row().includes("⠋"));
		clock.tick();
		assert.ok(row().includes("⠙"));
		clock.tick(8);
		assert.ok(row().includes("⠏"));
		clock.tick();
		assert.ok(row().includes("⠋"), "the frames wrap after the last one");
		assert.equal(fake.statusCalls.length, calls, "ticks never touch the count line");
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), "↓ 1 shell");
	});

	it("stops the clock when nothing runs, so an open panel is not redrawn while idle", async () => {
		const clock = fakeClock();
		const { controller, fake, publish } = setup({ clock });
		controller.startSession(fake.ctx);
		publish([running]);
		fake.press("\u001b[B");
		await flush();
		assert.equal(clock.running(), 1);
		publish([{ ...running, status: "done", endedAt: 1 }]);
		assert.equal(fake.statuses.get(BACKGROUND_PANEL_STATUS_KEY), undefined);
		assert.equal(clock.running(), 0, "the clock stops when the last job ends");
	});

	it("stops the clock on shutdown and on session replacement", async () => {
		const clock = fakeClock();
		const { controller, fake, publish } = setup({ clock });
		controller.startSession(fake.ctx);
		publish([running]);
		fake.press("\u001b[B");
		await flush();
		assert.equal(clock.running(), 1);
		controller.shutdown();
		assert.equal(clock.running(), 0);
		publish([running]);
		assert.equal(clock.running(), 0, "snapshots are ignored once the session is gone");
	});

	it("publishes the status only when its text changes", () => {
		const { controller, fake, publish } = setup();
		controller.startSession(fake.ctx);
		publish([running]);
		const calls = fake.statusCalls.length;
		publish([running]);
		publish([{ ...running, id: "2", title: "another shell", status: "running" }]);
		assert.equal(fake.statusCalls.length, calls, "the same summary is not republished");
	});
});
