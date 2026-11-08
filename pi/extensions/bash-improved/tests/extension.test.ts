/**
 * End to end through a real Pi session: the faux model makes the tool calls, the extension replaces
 * the bash tool (with its `tasks` command), and real processes run. PI_BASH_WAIT_SECONDS is 1
 * (see tests/setup.mjs).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type FauxResponseStep, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import bashImproved from "../index.ts";
import { groupAlive } from "../tasks.ts";
import { dirname } from "node:path";

interface Harness {
	session: AgentSession;
	calls: () => number;
	close: (reason?: "quit" | "reload" | "new" | "resume" | "fork") => Promise<void>;
}

interface HarnessOptions {
	mode?: "rpc" | "print" | "tui";
	/** Agent dir and scratch space; pass the same one to reopen a session. */
	dir?: string;
	/** Continue an existing session, for example one reopened from a session file. */
	sessionManager?: SessionManager;
	/** Stand-in for the terminal, so notifications can be observed. */
	ui?: Record<string, unknown>;
	/** Receives each call's `structuredContent`; Pi's tool result messages do not keep it. */
	structuredResults?: unknown[];
}

/** Report the machine-readable half of every tool result, which session history drops. */
function structuredResultCapture(results: unknown[]): (pi: ExtensionAPI) => void {
	return (pi) => {
		pi.on("tool_result", (event) => {
			results.push(event.structuredContent);
		});
	};
}

async function harness(responses: FauxResponseStep[], options: HarnessOptions = {}): Promise<Harness> {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "session-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(responses);
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	modelRuntime.registerNativeProvider(faux.provider);
	const resourceLoader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: dir,
		extensionFactories: [bashImproved, ...(options.structuredResults ? [structuredResultCapture(options.structuredResults)] : [])],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager: options.sessionManager ?? SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		tools: ["bash"],
	});
	await session.bindExtensions({ mode: options.mode ?? "rpc", uiContext: options.ui as never });
	return {
		session,
		calls: () => faux.state.callCount,
		close: async (reason = "quit") => {
			await session.extensionRunner.emit({ type: "session_shutdown", reason });
			session.dispose();
		},
	};
}

function bash(args: Record<string, unknown>): FauxResponseStep {
	return fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" });
}

/** The model managing tasks: a `tasks` command in bash. */
function tasks(command: string): FauxResponseStep {
	return bash({ command: `tasks ${command}`.trim() });
}

function text(message: { content: unknown }): string {
	const content = message.content as string | Array<{ type: string; text?: string }>;
	return typeof content === "string" ? content : content.map((part) => part.text ?? "").join("");
}

function toolResults(session: AgentSession): Array<{ content: unknown; isError?: boolean; details?: any }> {
	return session.messages.filter((message) => message.role === "toolResult") as never;
}

function notices(session: AgentSession): string[] {
	return session.messages
		.filter((message) => message.role === "custom" && (message as { customType?: string }).customType === "background-task")
		.map(text);
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stand-in for the terminal: records notifications and widgets, answers dialogs from a script. */
function fakeTui(answers: Array<string | undefined> = []) {
	const notified: string[] = [];
	const widgets: Array<string[] | undefined> = [];
	const dialogs: Array<{ kind: string; title: string; options?: string[]; text?: string }> = [];
	return {
		notified,
		widgets,
		dialogs,
		ui: {
			theme: { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value },
			notify: (message: string) => notified.push(message),
			setStatus: () => {},
			setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines),
			select: async (title: string, options: string[]) => {
				dialogs.push({ kind: "select", title, options });
				const answer = answers.shift();
				return answer === undefined ? undefined : (options.find((option) => option.startsWith(answer)) ?? answer);
			},
			editor: async (title: string, prefill?: string) => {
				dialogs.push({ kind: "editor", title, text: prefill });
				return undefined;
			},
		},
	};
}

test("a long command returns after the wait, and its exit wakes the agent with the result", async () => {
	const h = await harness([
		bash({ command: "echo begin; sleep 2; echo finish" }),
		fauxAssistantMessage("It is still building."),
		fauxAssistantMessage("The build finished."),
	]);
	try {
		const started = Date.now();
		await h.session.prompt("build it");
		assert.ok(Date.now() - started < 1900, `the turn took ${Date.now() - started}ms`);
		const [result] = toolResults(h.session);
		assert.match(
			text(result),
			/^begin\n\nStill running after 1s, so it continues in the background as task 1 \(pid \d+\)\.\nYou get a message when it exits; keep working meanwhile\. `tasks output 1` shows its new output, `tasks wait 1` waits for it, `tasks stop 1` stops it\./,
		);
		assert.equal(result.details.backgroundTask.id, 1);
		assert.equal(result.details.backgroundTask.status, "running");

		await until(() => h.calls() === 3 && h.session.isStreaming === false);
		const [notice] = notices(h.session);
		assert.match(notice, /^Background task 1 `echo begin; sleep 2; echo finish` exited with code 0 after 2s\.\nLast output:\nbegin\nfinish\nFull output: .*task-1\.log$/);
	} finally {
		await h.close();
	}
});

test("run_in_background returns at once; `tasks` lists, reads, waits and stops, as bash commands, without a message", async () => {
	const structured: unknown[] = [];
	const h = await harness(
		[
			bash({ command: "echo ready; sleep 1; echo tick; sleep 30", description: "Start the dev server", run_in_background: "true" }),
			tasks(""),
			tasks("wait 1 --timeout 1.5"),
			tasks("output %1"),
			bash({ command: "cd /tmp && tasks stop task-1" }),
			tasks("list"),
			tasks("output 7"),
			tasks("stop 1"),
			tasks("bogus"),
			bash({ command: "tasks | head -1" }),
			bash({ command: "echo first; tasks" }),
			fauxAssistantMessage("Done."),
		],
		{ structuredResults: structured },
	);
	try {
		const started = Date.now();
		await h.session.prompt("start the server");
		const results = toolResults(h.session).map(text);
		assert.match(results[0], /^ready\n\nCommand running in the background as task 1 \(pid \d+\)\./);
		assert.deepEqual(structured[0], { ...(structured[0] as object), task_id: "1", running: true });
		assert.match(results[1], /^1 {2}Start the dev server {2}running for \d+s {2}\(pid \d+, output .*task-1\.log\)\n$/);
		// A wait that runs out says so and shows what is new; `ready` was already in the bash result.
		assert.match(results[2], /^Waited 1\.5s; it keeps running and you get a message when it exits\.\n\nTask 1 Start the dev server is still running \(for \d+s\)\.\nNew output:\ntick\nFull output: /);
		assert.match(results[3], /\nNo new output since you last saw its output\.\n/);
		assert.equal(results[4], "Stopped task 1 Start the dev server.\n");
		assert.match(results[5], /^1 {2}Start the dev server {2}was stopped after \d+s/);
		assert.match(results[6], /^tasks: no background task 7\n1 [\s\S]*Command exited with code 1$/);
		assert.equal(toolResults(h.session)[6].isError, true);
		assert.match(results[7], /^Task 1 Start the dev server already was stopped after \d+s\.\n$/);
		assert.match(results[8], /^tasks: unknown command bogus\nusage: tasks /);
		// Starting with `tasks` and going on is refused before anything runs; `tasks` later on reaches the stand-in.
		assert.match(results[9], /^Not run: `tasks` works only as a bash command of its own/);
		assert.equal(toolResults(h.session)[9].isError, true);
		assert.match(results[10], /^first\ntasks: run it as a bash command of its own/);
		assert.ok(Date.now() - started < 6000);
		await sleep(500);
		assert.equal(h.calls(), 12);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("a task waited for to its end sends no message, and its report names the command", async () => {
	const h = await harness([
		bash({ command: "sleep 1.5; echo ok", description: "Check things" }),
		tasks("wait 1"),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("run it");
		const results = toolResults(h.session).map(text);
		assert.match(results[0], /task 1/);
		assert.match(results[1], /^Background task 1 Check things exited with code 0 after 2s\.\nCommand: `sleep 1\.5; echo ok`\nLast output:\nok\n/);
		await sleep(500);
		assert.equal(h.calls(), 3);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("tasks wait exits with the task's own status, like the shell's wait", async () => {
	const h = await harness([
		bash({ command: "sleep 1.5; echo broken >&2; exit 3", is_background: true }),
		tasks("wait 1"),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("go");
		const [, waited] = toolResults(h.session);
		assert.equal(waited.isError, true);
		assert.match(text(waited), /^Background task 1 `sleep 1\.5; echo broken >&2; exit 3` exited with code 3 after \d+s\.\nLast output:\nbroken\n[\s\S]*Command exited with code 3$/);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("a wait that an aborted turn gives up on still lets the task's message arrive", async () => {
	const h = await harness([
		bash({ command: "sleep 2; echo finished", run_in_background: true }),
		tasks("wait 1"),
		fauxAssistantMessage("Still building."),
	]);
	try {
		const turn = h.session.prompt("build it");
		await until(() => toolResults(h.session).length === 1);
		await sleep(200);
		await h.session.abort();
		await turn;
		assert.deepEqual(notices(h.session), []);
		await until(() => notices(h.session).length === 1);
		assert.match(notices(h.session)[0], /^Background task 1 `sleep 2; echo finished` exited with code 0 after \d+s\./);
	} finally {
		await h.close();
	}
});

test("a foreground sleep is refused, and the answer points at the running tasks", async () => {
	const structured: unknown[] = [];
	const h = await harness(
		[
			bash({ command: "sleep 30 && curl localhost:3000" }),
			bash({ command: "sleep 30", run_in_background: true }),
			bash({ command: "sleep 1m; tail log" }),
			bash({ command: "sleep 0.2 && echo short" }),
			bash({ command: "for i in 1 2; do sleep 0.1; done; echo looped" }),
			fauxAssistantMessage("Done."),
		],
		{ structuredResults: structured },
	);
	try {
		const started = Date.now();
		await h.session.prompt("wait for it");
		const results = toolResults(h.session);
		assert.match(text(results[0]), /^Not run: `sleep 30` would only hold you up\..*\nNone of your background tasks is still running\./);
		assert.equal(results[0].isError, true);
		assert.equal((structured[0] as { exit_code?: number }).exit_code, 1);
		assert.match(text(results[1]), /Command running in the background as task 1/);
		assert.match(text(results[2]), /^Not run: `sleep 60`.*\nTo block until one is done, run `tasks wait <id>`.*Running: 1 `sleep 30`\./);
		assert.equal(text(results[3]), "short\n");
		assert.equal(text(results[4]), "looped\n");
		assert.ok(Date.now() - started < 5000);
	} finally {
		await h.close();
	}
});

test("the tool text says when a command moves to the background, what the flag saves, and not to poll", async () => {
	const tools: Array<{ name: string; description?: string; parameters?: any }> = [];
	let prompt = "";
	const h = await harness([
		(context) => {
			for (const message of context.messages) {
				if (message.role !== "system") continue;
				tools.push(...(message.toolsAdded ?? []));
				prompt += Object.values(message.sections ?? {}).join("\n");
			}
			return fauxAssistantMessage("Done.");
		},
	]);
	try {
		await h.session.prompt("hi");
		const bashTool = tools.find((tool) => tool.name === "bash");
		const { run_in_background, timeout, description } = bashTool?.parameters?.properties ?? {};
		assert.match(bashTool?.description ?? "", /still running after 1s is not killed: it keeps running as a background task.*run_in_background: true starts it in the background right away/s);
		assert.match(run_in_background?.description ?? "", /right away \(returning after about 1s, with any startup error\) instead of after 1s/);
		assert.match(timeout?.description ?? "", /also once it runs in the background .*leave it unset for servers/);
		assert.match(description?.description ?? "", /5-10 words/);
		assert.deepEqual(Object.keys(bashTool?.parameters?.properties ?? {}), ["command", "timeout", "run_in_background", "description", "cwd", "ready"]);
		assert.deepEqual(Object.keys(bashTool?.parameters?.properties?.ready?.properties ?? {}), ["port", "host", "log", "timeout"]);
		assert.deepEqual(tools.map((tool) => tool.name).filter((name) => name !== "bash" && /task/.test(name)), [], "no extra tools");
		assert.match(bashTool?.description ?? "", /`tasks` lists them, `tasks output <id>` shows new output, `tasks wait <id> \[--timeout <secs>\]` waits for one to exit, `tasks stop <id>` stops one/);
		assert.match(prompt, /Don't sleep or poll to wait for a background task/);
		assert.match(prompt, /Start a server with `ready`, such as `ready: \{port: 3000\}`.*so you need no curl loop/);
		assert.match(prompt, /Use `cwd` to run a command in another directory/);
		assert.match(prompt, /don't append `; echo \$\?`, `\|\| true`/);
	} finally {
		await h.close();
	}
});

test("a failed task wakes the agent and reads as a failure", async () => {
	const h = await harness([
		bash({ command: "sleep 1.3; echo boom >&2; exit 2" }),
		fauxAssistantMessage("Waiting."),
		fauxAssistantMessage("It failed."),
	]);
	try {
		await h.session.prompt("test it");
		await until(() => h.calls() === 3 && h.session.isStreaming === false);
		const [notice] = notices(h.session);
		assert.match(notice, /exited with code 2 after 1s\.\nLast output:\nboom\n/);
		const message = h.session.messages.find((m) => m.role === "custom") as { details?: { failed?: boolean; status?: string } };
		assert.equal(message.details?.failed, true);
		assert.equal(message.details?.status, "failed");
	} finally {
		await h.close();
	}
});

test("commands run without editors, pagers, credential prompts or stdin that need a terminal", async () => {
	const h = await harness([
		bash({
			command:
				'echo $GIT_EDITOR $GIT_SEQUENCE_EDITOR $EDITOR $PAGER $GIT_PAGER $GIT_TERMINAL_PROMPT; echo $MANPAGER $GH_PAGER "[$AWS_PAGER]" $GCM_INTERACTIVE $SSH_ASKPASS $DEBIAN_FRONTEND $PIP_NO_INPUT $npm_config_fund; echo "${CI-unset}"; read line || echo no-stdin',
		}),
		fauxAssistantMessage("Done."),
	]);
	const ci = process.env.CI;
	delete process.env.CI;
	try {
		await h.session.prompt("check");
		assert.equal(text(toolResults(h.session)[0]), "true true true cat cat 0\ncat cat [] never false noninteractive 1 false\nunset\nno-stdin\n");
	} finally {
		if (ci !== undefined) process.env.CI = ci;
		await h.close();
	}
});

test("an explicit timeout still kills the command", async () => {
	const h = await harness([bash({ command: "tail -f /dev/null", timeout: "0.5" }), fauxAssistantMessage("Done.")]);
	try {
		await h.session.prompt("go");
		const [result] = toolResults(h.session);
		assert.equal(result.isError, true);
		assert.match(text(result), /Command timed out after 0\.5 seconds/);
	} finally {
		await h.close();
	}
});

test("a one-shot run says that tasks stop when it ends, and shutdown stops them", async () => {
	const h = await harness([bash({ command: "sleep 30", run_in_background: true }), fauxAssistantMessage("Done.")], { mode: "print" });
	let pid: number | undefined;
	try {
		await h.session.prompt("go");
		const [result] = toolResults(h.session);
		assert.match(text(result), /This run ends when you finish and stops tasks still running then/);
		pid = result.details.backgroundTask.pid;
		assert.ok(groupAlive(pid));
	} finally {
		await h.close();
	}
	assert.ok(!groupAlive(pid));
});

test("/tasks without a terminal answers in the transcript without waking the agent", async () => {
	const h = await harness([bash({ command: "sleep 30", run_in_background: true }), fauxAssistantMessage("Started.")]);
	try {
		await h.session.prompt("/tasks");
		assert.equal(notices(h.session).at(-1), "No background tasks.");
		await h.session.prompt("start the server");
		const calls = h.calls();
		await h.session.prompt("/tasks");
		const listing = h.session.messages.filter((message) => message.role === "custom").at(-1) as {
			display?: boolean;
			customType?: string;
			content: unknown;
		};
		// BB drops notifications, so the listing has to be a message it displays.
		assert.equal(listing.customType, "background-task");
		assert.equal(listing.display, true);
		assert.match(text(listing), /^1 {2}`sleep 30` {2}running for \d+s/);
		await h.session.prompt("/tasks stop 1");
		assert.equal(h.calls(), calls);
		assert.match(notices(h.session).at(-1) ?? "", /^The user stopped background task 1 `sleep 30`\./);
		await h.session.prompt("/tasks");
		assert.match(notices(h.session).at(-1) ?? "", /^1 {2}`sleep 30` {2}was stopped after \d+s/);
		assert.equal(h.calls(), calls);
	} finally {
		await h.close();
	}
});

test("in the TUI a widget shows running tasks, and /tasks picks one to show its output or stop it", async () => {
	const tui = fakeTui(["1", "Show output", "1", "Stop"]);
	const h = await harness(
		[bash({ command: "echo hello; sleep 30", description: "Serve the docs", run_in_background: true }), fauxAssistantMessage("Started.")],
		{ mode: "tui", ui: tui.ui },
	);
	try {
		await h.session.prompt("start the server");
		assert.match(tui.widgets.at(-1)?.[0] ?? "", /^⏵ Running background command: Serve the docs \d+s$/);
		assert.match(tui.widgets.at(-1)?.[1] ?? "", /\/tasks to manage/);

		await h.session.prompt("/tasks");
		assert.match(tui.dialogs[0].options?.[0] ?? "", /^1 {2}running {2}\d+s {2}Serve the docs$/);
		assert.deepEqual(tui.dialogs[1].options, ["Show output", "Stop"]);
		assert.equal(tui.dialogs[2].kind, "editor");
		assert.match(tui.dialogs[2].text ?? "", /^\$ echo hello; sleep 30\n\nhello\n/);

		const calls = h.calls();
		await h.session.prompt("/tasks");
		assert.equal(tui.notified.at(-1), "Stopped task 1");
		await until(() => tui.widgets.at(-1) === undefined);
		assert.equal(h.calls(), calls, "stopping does not wake the agent");
		assert.deepEqual(notices(h.session), [], "the model hears about it on its next turn");
	} finally {
		await h.close();
	}
});

test("quitting stops the tasks; a reload keeps them for the next runtime", async () => {
	const h = await harness([bash({ command: "sleep 30", run_in_background: true }), fauxAssistantMessage("Started.")]);
	let pid: number | undefined;
	try {
		await h.session.prompt("start the server");
		pid = toolResults(h.session)[0].details.backgroundTask.pid;
	} finally {
		await h.close("reload");
	}
	try {
		assert.ok(groupAlive(pid));
		const next = await harness([tasks(""), fauxAssistantMessage("Listed.")], {
			sessionManager: h.session.sessionManager as SessionManager,
		});
		try {
			await next.session.prompt("what runs?");
			assert.match(text(toolResults(next.session).at(-1) as never), /^1 {2}`sleep 30` {2}running/);
		} finally {
			await next.close("quit");
		}
		assert.ok(!groupAlive(pid));
	} finally {
		try {
			process.kill(-(pid as number), "SIGKILL");
		} catch {
			// The task is gone already.
		}
	}
});

test("state.json tells other programs about the tasks, and a stop-<id> file stops one as the user", async () => {
	const previous = process.env.BB_THREAD_ID;
	process.env.BB_THREAD_ID = "thr_test";
	const h = await harness([
		bash({ command: "sleep 30", description: "Hold the port", run_in_background: true }),
		fauxAssistantMessage("Started."),
		tasks("wait 1 --timeout 20"),
		fauxAssistantMessage("Stopped."),
	]);
	try {
		await h.session.prompt("start it");
		const [result] = toolResults(h.session);
		const dir = dirname(result.details.backgroundTask.logPath);
		const read = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
		const state = read();
		assert.equal(state.bbThreadId, "thr_test");
		assert.equal(state.piPid, process.pid);
		assert.deepEqual(
			state.tasks.map((task: { id: number; description: string; status: string }) => [task.id, task.description, task.status]),
			[[1, "Hold the port", "running"]],
		);
		const calls = h.calls();
		const waiting = h.session.prompt("wait for it");
		await until(() => h.calls() === calls + 1);
		writeFileSync(join(dir, "stop-1"), "");
		await until(() => read().tasks[0].status === "killed");
		assert.ok(!existsSync(join(dir, "stop-1")), "the request is consumed");
		await waiting;
		// A wait on a task the user stopped is not an error.
		const waited = toolResults(h.session).at(-1);
		assert.equal(waited?.isError, false);
		assert.match(text(waited as never), /^Background task 1 Hold the port was stopped after \d+s\./);
		await until(() => notices(h.session).length === 1);
		assert.match(notices(h.session)[0], /^The user stopped background task 1 Hold the port\./);
	} finally {
		if (previous === undefined) delete process.env.BB_THREAD_ID;
		else process.env.BB_THREAD_ID = previous;
		await h.close();
	}
});

/** A TCP port nothing listens on right now. */
async function freePort(): Promise<number> {
	const { createServer } = await import("node:net");
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

test("a message from the user ends a foreground wait and a `tasks wait` early; the commands keep running", async () => {
	const h = await harness([
		// A timeout this short keeps the command in the foreground, so only the message can end the wait.
		bash({ command: "sleep 3; echo slow", timeout: 6 }),
		fauxAssistantMessage("Reading your message."),
		bash({ command: "sleep 3; echo later", run_in_background: true }),
		tasks("wait 2 --timeout 20"),
		fauxAssistantMessage("Reading your second message."),
		fauxAssistantMessage("Both ended."),
	]);
	try {
		let started = Date.now();
		const turn = h.session.prompt("go");
		await sleep(1500);
		await h.session.steer("one thing first");
		await turn;
		const first = toolResults(h.session)[0];
		assert.ok(Date.now() - started < 2800, `the first call took ${Date.now() - started}ms`);
		assert.match(text(first), /^Moved to the background early, as task 1 \(pid \d+\), to handle an incoming message; the command keeps running\./);
		assert.equal(first.details.backgroundTask.status, "running");

		started = Date.now();
		const second = h.session.prompt("and now");
		await until(() => toolResults(h.session).length === 2);
		await sleep(300);
		await h.session.steer("another thing");
		await second;
		const waited = toolResults(h.session)[2];
		assert.ok(Date.now() - started < 2800, `the wait took ${Date.now() - started}ms`);
		assert.match(text(waited), /^Stopped waiting to handle an incoming message; task 2 keeps running and you get a message when it exits\./);
		await until(() => notices(h.session).length > 0 && h.session.isStreaming === false);
	} finally {
		await h.close();
	}
});

test("a command whose short timeout comes soon after the wait stays in the foreground", async () => {
	const h = await harness([bash({ command: "sleep 1.5; echo done", timeout: 4 }), fauxAssistantMessage("Done.")]);
	try {
		await h.session.prompt("go");
		const [result] = toolResults(h.session);
		assert.equal(text(result), "done\n");
		assert.equal(result.details?.backgroundTask, undefined);
	} finally {
		await h.close();
	}
});

test("ready waits until a port accepts connections, and the server keeps running", async () => {
	const port = await freePort();
	const structured: unknown[] = [];
	const server = `setTimeout(() => require("net").createServer().listen(${port}, "127.0.0.1", () => console.log("up")), 1500)`;
	const h = await harness([bash({ command: `node -e '${server}'`, ready: { port } }), fauxAssistantMessage("Up.")], {
		structuredResults: structured,
	});
	try {
		const started = Date.now();
		await h.session.prompt("start it");
		const [result] = toolResults(h.session);
		assert.ok(Date.now() - started >= 1400, "it waited for the port");
		assert.match(text(result), new RegExp(`^up\\n\\nReady: port ${port}\\.\\nCommand running in the background as task 1 `));
		assert.equal(result.details.ready, "ready");
		assert.equal((structured[0] as { ready?: boolean }).ready, true);
		assert.equal(result.details.backgroundTask.status, "running");
	} finally {
		await h.close();
	}
});

test("ready waits for a log line; it says when the server never got ready or exited first", async () => {
	const port = await freePort();
	const h = await harness([
		bash({ command: 'echo booting; sleep 1.5; printf "\\033[32mListening on 1234\\033[0m\\n"; sleep 30', ready: '{"log": "Listening on \\\\d+"}' }),
		bash({ command: "echo starting; sleep 30", ready: { log: "never", timeout: 1.5 }, description: "Start the silent server" }),
		bash({ command: "echo bye", ready: { port } }),
		bash({ command: "sleep 1.5; echo crashed >&2; exit 4", ready: { port, timeout: 10 } }),
		bash({ command: "true", ready: { port: 70000 } }),
		bash({ command: "echo string port", ready: { port: String(port), timeout: "1" } }),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("start them");
		const results = toolResults(h.session);
		assert.match(text(results[0]), /^booting\n.*Listening on 1234.*\n\nReady: the log matching \/Listening on \\d\+\/\.\n/);
		assert.match(text(results[1]), /^starting\n\nNOT ready after 1\.5s: no output line matches \/never\/\. It keeps running\.\nCommand running in the background as task 2/);
		assert.equal(results[1].isError, false);
		assert.match(text(results[2]), new RegExp(`^bye\\n\\nNot ready: it exited before port ${port}\\.$`));
		assert.equal(results[2].isError, true);
		assert.match(text(results[3]), new RegExp(`^crashed\\n\\nNot ready: it exited with code 4 after 2s before port ${port}\\.\\n\\nCommand exited with code 4$`));
		assert.equal(results[3].isError, true);
		assert.match(text(results[4]), /^Not run: ready\.port must be a TCP port, not 70000\.$/);
		assert.match(text(results[5]), new RegExp(`^string port\\n\\nNot ready: it exited before port ${port}\\.$`));
		await sleep(700);
		assert.deepEqual(notices(h.session), [], "a task that exited while the call waited for it sends no message");
	} finally {
		await h.close();
	}
});

test("cwd runs the command in another directory; workdir is accepted too", async () => {
	const dir = mkdtempSync(join(tmpdir(), "session-"));
	const { mkdirSync } = await import("node:fs");
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "file"), "");
	const h = await harness(
		[
			bash({ command: "pwd", cwd: "sub" }),
			bash({ command: "pwd", workdir: join(dir, "sub") }),
			bash({ command: "pwd", cwd: "missing" }),
			bash({ command: "pwd", cwd: "file" }),
			fauxAssistantMessage("Done."),
		],
		{ dir },
	);
	try {
		await h.session.prompt("where");
		const results = toolResults(h.session).map(text);
		assert.equal(results[0], `${join(dir, "sub")}\n`);
		assert.equal(results[1], `${join(dir, "sub")}\n`);
		assert.equal(results[2], `Not run: the directory ${join(dir, "missing")} does not exist.`);
		assert.equal(results[3], `Not run: ${join(dir, "file")} is not a directory.`);
	} finally {
		await h.close();
	}
});

test("tasks that end close together are reported in one message", async () => {
	const h = await harness([
		// The second starts about a second after the first (run_in_background waits that long), so both end near 2.3s.
		bash({ command: "sleep 2.2; echo one", run_in_background: true }),
		bash({ command: "sleep 1.3; echo two >&2; exit 1", run_in_background: true }),
		fauxAssistantMessage("Both started."),
		fauxAssistantMessage("Read both."),
	]);
	try {
		await h.session.prompt("start both");
		await until(() => h.calls() === 4 && h.session.isStreaming === false);
		const all = notices(h.session);
		assert.equal(all.length, 1);
		assert.match(all[0], /^2 background tasks ended \(1 failed\)\.\n\nBackground task 1 `sleep 2\.2; echo one` exited with code 0[\s\S]*\n\nBackground task 2 `sleep 1\.3; echo two >&2; exit 1` exited with code 1/);
		const message = h.session.messages.find((m) => m.role === "custom") as { details?: { failed?: boolean; tasks?: unknown[] } };
		assert.equal(message.details?.failed, true);
		assert.equal(message.details?.tasks?.length, 2);
	} finally {
		await h.close();
	}
});
