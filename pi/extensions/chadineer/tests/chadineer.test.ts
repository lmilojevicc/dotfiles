import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import chadineerExtension, {
	CHADINEER_PROMPT,
	CHADINEER_STATE_ENTRY,
	CHADINEER_STATUS_KEY,
	CHADINEER_USAGE,
	parseChadineerCommand,
	restoreChadineerState,
} from "../index.ts";

const promptFile = readFileSync(new URL("../PROMPT.md", import.meta.url), "utf8").trim();

type Handler = (...args: any[]) => any;
type TestEntry = {
	type: "custom";
	customType: string;
	data: unknown;
};

function customEntry(data: unknown, customType = CHADINEER_STATE_ENTRY): TestEntry {
	return { type: "custom", customType, data };
}

function createRuntime(initialEntries: TestEntry[] = []) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const appended: Array<{ customType: string; data: unknown }> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const statusChanges: Array<{ key: string; text: string | undefined }> = [];
	const statuses = new Map<string, string>();
	let entries = initialEntries;

	chadineerExtension({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
		},
	} as any);

	const ctx = {
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus: (key: string, text: string | undefined) => {
				statusChanges.push({ key, text });
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
		},
		sessionManager: { getBranch: () => entries },
	};

	return {
		appended,
		commandNames: [...commands.keys()],
		notifications,
		statuses,
		statusChanges,
		before(systemPrompt = "base prompt") {
			return handlers.get("before_agent_start")?.({ systemPrompt }, ctx);
		},
		command(args: string) {
			return commands.get("chadineer")?.handler(args, ctx);
		},
		setEntries(next: TestEntry[]) {
			entries = next;
		},
		start() {
			handlers.get("session_start")?.({ reason: "startup" }, ctx);
		},
		tree() {
			handlers.get("session_tree")?.({}, ctx);
		},
	};
}

test("registers only /chadineer and parses the documented command forms", () => {
	assert.deepEqual(createRuntime().commandNames, ["chadineer"]);
	assert.deepEqual(parseChadineerCommand(""), { kind: "toggle" });
	assert.deepEqual(parseChadineerCommand(" ON "), { kind: "set", enabled: true });
	assert.deepEqual(parseChadineerCommand("off"), { kind: "set", enabled: false });
	assert.deepEqual(parseChadineerCommand("status"), { kind: "status" });
	for (const input of ["toggle", "on now", "status extra", "enable", "1"]) {
		assert.deepEqual(parseChadineerCommand(input), { kind: "invalid" });
	}
});

test("defaults off, toggles transitions, and leaves idempotent commands unpersisted", () => {
	const runtime = createRuntime();
	runtime.start();
	assert.equal(runtime.statuses.has(CHADINEER_STATUS_KEY), false);
	assert.equal(runtime.before(), undefined);

	runtime.command("");
	assert.deepEqual(runtime.appended, [
		{ customType: CHADINEER_STATE_ENTRY, data: { enabled: true } },
	]);
	assert.equal(runtime.statuses.get(CHADINEER_STATUS_KEY), "chadineer");
	assert.deepEqual(runtime.notifications.at(-1), { message: "Chadineer is on", level: "info" });

	runtime.command("on");
	assert.equal(runtime.appended.length, 1);
	assert.deepEqual(runtime.notifications.at(-1), {
		message: "Chadineer is already on",
		level: "info",
	});

	runtime.command("off");
	assert.deepEqual(runtime.appended.at(-1), {
		customType: CHADINEER_STATE_ENTRY,
		data: { enabled: false },
	});
	assert.equal(runtime.statuses.has(CHADINEER_STATUS_KEY), false);
	assert.equal(runtime.before(), undefined);

	runtime.command("off");
	assert.equal(runtime.appended.length, 2);
	assert.deepEqual(runtime.notifications.at(-1), {
		message: "Chadineer is already off",
		level: "info",
	});
});

test("status reports without mutation and invalid or extra arguments only show usage", () => {
	const runtime = createRuntime();
	runtime.start();
	runtime.command("status");
	assert.deepEqual(runtime.notifications.at(-1), { message: "Chadineer is off", level: "info" });

	for (const input of ["wat", "on extra", "status extra"]) runtime.command(input);
	assert.deepEqual(runtime.appended, []);
	assert.equal(runtime.statuses.has(CHADINEER_STATUS_KEY), false);
	assert.deepEqual(runtime.notifications.slice(-3), [
		{ message: CHADINEER_USAGE, level: "warning" },
		{ message: CHADINEER_USAGE, level: "warning" },
		{ message: CHADINEER_USAGE, level: "warning" },
	]);
});

test("enabled mode appends the Markdown prompt after prior prompt modifications", () => {
	const runtime = createRuntime();
	runtime.start();
	runtime.command("on");
	assert.deepEqual(runtime.before("base plus earlier extension"), {
		systemPrompt: `base plus earlier extension\n\n${promptFile}`,
	});
});

test("restores the latest valid branch state on session start and tree changes", () => {
	const runtime = createRuntime([
		customEntry({ enabled: false }),
		customEntry({ enabled: true }),
		customEntry({ enabled: "invalid" }),
		customEntry({ enabled: false }, "another-extension"),
	]);
	runtime.start();
	assert.equal(runtime.statuses.get(CHADINEER_STATUS_KEY), "chadineer");
	assert.ok(runtime.before()?.systemPrompt.endsWith(CHADINEER_PROMPT));
	assert.deepEqual(runtime.appended, [], "restoration does not persist another entry");

	runtime.setEntries([customEntry({ enabled: false })]);
	runtime.tree();
	assert.equal(runtime.statuses.has(CHADINEER_STATUS_KEY), false);
	assert.equal(runtime.before(), undefined);

	runtime.setEntries([customEntry({ enabled: true })]);
	runtime.tree();
	assert.equal(runtime.statuses.get(CHADINEER_STATUS_KEY), "chadineer");
	assert.ok(runtime.before()?.systemPrompt.endsWith(CHADINEER_PROMPT));
	assert.deepEqual(runtime.statusChanges.slice(-2), [
		{ key: CHADINEER_STATUS_KEY, text: undefined },
		{ key: CHADINEER_STATUS_KEY, text: "chadineer" },
	]);
});

test("missing or wholly malformed branch state falls back off", () => {
	assert.equal(restoreChadineerState([]), false);
	assert.equal(
		restoreChadineerState([
			customEntry(null),
			customEntry({}),
			customEntry({ enabled: "yes" }),
		]),
		false,
	);

	const runtime = createRuntime([customEntry({ enabled: "yes" })]);
	runtime.start();
	assert.equal(runtime.statuses.has(CHADINEER_STATUS_KEY), false);
	assert.equal(runtime.before(), undefined);
});

test("loads the canonical prompt from Markdown without duplicating it inline", () => {
	const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.equal(CHADINEER_PROMPT, promptFile);
	assert.doesNotMatch(indexSource, /## Chadineer development guidelines/);
	assert.doesNotMatch(indexSource, /Prefer the simplest adequate solution/);
});

test("bundled prompt retains required outcomes and excludes brittle slogans", () => {
	for (const phrase of [
		"YAGNI",
		"suitable implementation already exist",
		"standard library",
		"native platform feature",
		"already-installed dependency",
		"speculative abstractions",
		"root cause",
		"trust boundaries",
		"security",
		"accessibility",
		"data-loss prevention",
		"in proportion to risk",
		"maintained regression coverage",
		"existing test infrastructure",
		"higher-priority instructions",
		"applicable acceptance criteria",
		"hardware-facing code",
		"calibration, drift, tolerances",
	]) {
		assert.match(CHADINEER_PROMPT, new RegExp(phrase, "i"));
	}

	for (const phrase of [
		"make it one line",
		"trivial one-liners",
		"one runnable check",
		"no frameworks",
		"no fixtures",
		"fewest files",
		"shortest diff",
		"ponytail:",
		"anything explicitly requested",
	]) {
		assert.doesNotMatch(CHADINEER_PROMPT, new RegExp(phrase, "i"));
	}
});

test("static append-system prompt no longer includes the migrated guidelines", () => {
	const appendSystem = readFileSync(new URL("../../../APPEND_SYSTEM.md", import.meta.url), "utf8");
	assert.equal(appendSystem.includes(CHADINEER_PROMPT), false);
	assert.doesNotMatch(appendSystem, /^## General development guidelines$/m);
	assert.doesNotMatch(appendSystem, /Can it be one line\? Make it one line\./);
	assert.doesNotMatch(appendSystem, /Non-trivial logic leaves ONE runnable check behind/);
});
