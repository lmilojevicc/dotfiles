/**
 * End to end through a real Pi session: the faux model makes the tool calls, the extension replaces
 * the bash tool and adds jobs, and real processes run. PI_BASH_WAIT_SECONDS is 1 (see tests/setup.mjs).
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
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
import bashJobs from "../index.ts";
import { groupAlive } from "../jobs.ts";

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
		extensionFactories: [bashJobs, ...(options.structuredResults ? [structuredResultCapture(options.structuredResults)] : [])],
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
		tools: ["bash", "jobs"],
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

function jobs(args: Record<string, unknown>): FauxResponseStep {
	return fauxAssistantMessage(fauxToolCall("jobs", args), { stopReason: "toolUse" });
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
		.filter((message) => message.role === "custom" && (message as { customType?: string }).customType === "bash-job")
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
		assert.match(text(result), /^begin\n\nStill running after 1s, so it continues in the background as job 1 \(pid \d+\)\.\nYou get a message when it exits; keep working meanwhile\./);
		assert.equal(result.details.job.id, 1);

		await until(() => h.calls() === 3 && h.session.isStreaming === false);
		const [notice] = notices(h.session);
		assert.match(notice, /^Background job 1 `echo begin; sleep 2; echo finish` exited with code 0 after 2s\.\nLast output:\nbegin\nfinish\nFull output: /);
	} finally {
		await h.close();
	}
});

test("background: true returns at once, and the jobs tool lists, reads, and stops the job without a message", async () => {
	const structured: unknown[] = [];
	const h = await harness(
		[
			bash({ command: "echo ready; sleep 1; echo tick; sleep 30", run_in_background: "true" }),
			jobs({ action: "list" }),
			jobs({ action: "wait", id: 1, timeout: 1.5 }),
			jobs({ action: "output", id: "1" }),
			jobs({ action: "kill", id: 1 }),
			jobs({ action: "list" }),
			jobs({ action: "output", id: 7 }),
			jobs({ action: "kill" }),
			fauxAssistantMessage("Done."),
		],
		{ structuredResults: structured },
	);
	try {
		const started = Date.now();
		await h.session.prompt("start the server");
		const results = toolResults(h.session).map(text);
		assert.match(results[0], /^ready\n\nStarted in the background as job 1 \(pid \d+\)\./);
		assert.deepEqual((structured[0] as { job?: number; running?: boolean }), { ...(structured[0] as object), job: 1, running: true });
		assert.match(results[1], /^1 {2}`echo ready; sleep 1; echo tick; sleep 30` {2}running for \d+s {2}\(pid \d+, output .*job-1\.log\)$/);
		// A wait that runs out says so and shows what is new; `ready` was already in the bash result.
		assert.match(results[2], /^Waited 1\.5s; you still get a message when it exits\.\n\nJob 1 .* is still running \(for \d+s\)\.\nNew output:\ntick\nFull output: /);
		assert.match(results[3], /\nNo new output since you last looked\.\n/);
		assert.equal(results[4], "Stopped job 1 `echo ready; sleep 1; echo tick; sleep 30`.");
		assert.match(results[5], /^1 {2}`.*` {2}was stopped after \d+s/);
		assert.match(results[6], /^No job 7\.\n1 /);
		assert.equal(toolResults(h.session)[6].isError, true);
		assert.match(results[7], /^kill needs the job's id\./);
		assert.ok(Date.now() - started < 6000);
		await sleep(500);
		assert.equal(h.calls(), 9);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("a job waited for to its end sends no message", async () => {
	const h = await harness([
		bash({ command: "sleep 1.5; echo ok" }),
		jobs({ action: "wait", id: 1 }),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("run it");
		const results = toolResults(h.session).map(text);
		assert.match(results[0], /job 1/);
		assert.match(results[1], /^Job 1 `sleep 1\.5; echo ok` exited with code 0 after 2s\.\nLast output:\nok\n/);
		await sleep(500);
		assert.equal(h.calls(), 3);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("wait without an id waits for every running job", async () => {
	const h = await harness([
		bash({ command: "sleep 3; echo a", background: true }),
		bash({ command: "sleep 2.5; exit 3", background: true }),
		jobs({ action: "wait" }),
		jobs({ action: "wait" }),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("run both");
		const results = toolResults(h.session);
		assert.match(text(results[2]), /^Job 1 .* exited with code 0.*\n[\s\S]*\n\nJob 2 .* exited with code 3/);
		assert.equal(results[2].isError, true, "one of them failed");
		assert.equal(text(results[3]), "No background jobs are running.");
		await sleep(300);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("a wait that an aborted turn gives up on still lets the job's message arrive", async () => {
	const h = await harness([
		bash({ command: "sleep 2; echo finished", background: true }),
		jobs({ action: "wait", id: 1 }),
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
		assert.match(notices(h.session)[0], /^Background job 1 `sleep 2; echo finished` exited with code 0 after \d+s\./);
	} finally {
		await h.close();
	}
});

test("a foreground sleep is refused, and the answer points at the running jobs", async () => {
	const structured: unknown[] = [];
	const h = await harness(
		[
			bash({ command: "sleep 30 && curl localhost:3000" }),
			bash({ command: "sleep 30", background: true }),
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
		assert.match(text(results[0]), /^Not run: `sleep 30` would only hold you up\..*\nNo background jobs are running\./);
		assert.equal(results[0].isError, true);
		assert.equal((structured[0] as { exit_code?: number }).exit_code, 1);
		assert.match(text(results[1]), /Started in the background as job 1/);
		assert.match(text(results[2]), /^Not run: `sleep 60`.*\nTo block until one is done, use the jobs tool's wait action.*Running: 1 `sleep 30`\./);
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
		const jobsTool = tools.find((tool) => tool.name === "jobs");
		const { background, timeout } = bashTool?.parameters?.properties ?? {};
		assert.match(bashTool?.description ?? "", /still running after 1s keeps running in the background as a job.*background: true returns after about 1s/s);
		assert.match(background?.description ?? "", /return after about 1s, with any startup error, instead of waiting 1s first/);
		assert.match(timeout?.description ?? "", /even after it moves to the background .*leave it unset for servers/);
		assert.deepEqual(jobsTool?.parameters?.properties?.action?.enum, ["list", "output", "wait", "kill"]);
		assert.match(prompt, /Don't sleep or poll to wait for a job/);
		assert.match(prompt, /To check that a server you started is ready, use one bounded check, such as `timeout 30 sh -c 'until curl/);
	} finally {
		await h.close();
	}
});

test("a failed job wakes the agent and reads as a failure", async () => {
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
		const message = h.session.messages.find((m) => m.role === "custom") as { details?: { failed?: boolean } };
		assert.equal(message.details?.failed, true);
	} finally {
		await h.close();
	}
});

test("commands run without editors, pagers, credential prompts or stdin that need a terminal", async () => {
	const h = await harness([
		bash({ command: "echo $GIT_EDITOR $GIT_SEQUENCE_EDITOR $EDITOR $PAGER $GIT_PAGER $GIT_TERMINAL_PROMPT; read line || echo no-stdin" }),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("check");
		assert.equal(text(toolResults(h.session)[0]), "true true true cat cat 0\nno-stdin\n");
	} finally {
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

test("a one-shot run says that jobs stop when it ends, and shutdown stops them", async () => {
	const h = await harness([bash({ command: "sleep 30", background: true }), fauxAssistantMessage("Done.")], { mode: "print" });
	let pid: number | undefined;
	try {
		await h.session.prompt("go");
		const [result] = toolResults(h.session);
		assert.match(text(result), /This run ends when you finish and stops jobs still running then/);
		pid = result.details.job.pid;
		assert.ok(groupAlive(pid));
	} finally {
		await h.close();
	}
	assert.ok(!groupAlive(pid));
});

test("/jobs outside the TUI answers in the transcript without waking the agent", async () => {
	const h = await harness([bash({ command: "sleep 30", background: true }), fauxAssistantMessage("Started.")]);
	try {
		await h.session.prompt("/jobs");
		assert.equal(notices(h.session).at(-1), "No background jobs.");
		await h.session.prompt("start the server");
		const calls = h.calls();
		await h.session.prompt("/jobs");
		const listing = h.session.messages.filter((message) => message.role === "custom").at(-1) as {
			display?: boolean;
			customType?: string;
			content: unknown;
		};
		// BB drops notifications, so the listing has to be a message it displays.
		assert.equal(listing.customType, "bash-job");
		assert.equal(listing.display, true);
		assert.match(text(listing), /^1 {2}`sleep 30` {2}running for \d+s/);
		await h.session.prompt("/jobs kill 1");
		assert.equal(h.calls(), calls);
		assert.match(notices(h.session).at(-1) ?? "", /^The user stopped background job 1 `sleep 30`\./);
		await h.session.prompt("/jobs");
		assert.match(notices(h.session).at(-1) ?? "", /^1 {2}`sleep 30` {2}was stopped after \d+s/);
		assert.equal(h.calls(), calls);
	} finally {
		await h.close();
	}
});

test("the TUI keeps the notification for /jobs instead of a message", async () => {
	const notified: string[] = [];
	const h = await harness([bash({ command: "sleep 30", background: true }), fauxAssistantMessage("Started.")], {
		mode: "tui",
		ui: { notify: (message: string) => notified.push(message), setStatus: () => {} },
	});
	try {
		await h.session.prompt("start the server");
		await h.session.prompt("/jobs");
		assert.match(notified.at(-1) ?? "", /^1 {2}`sleep 30` {2}running for \d+s/);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("quitting stops the jobs; a reload keeps them for the next runtime", async () => {
	const h = await harness([bash({ command: "sleep 30", background: true }), fauxAssistantMessage("Started.")]);
	let pid: number | undefined;
	try {
		await h.session.prompt("start the server");
		pid = toolResults(h.session)[0].details.job.pid;
	} finally {
		await h.close("reload");
	}
	try {
		assert.ok(groupAlive(pid));
		const next = await harness([jobs({ action: "list" }), fauxAssistantMessage("Listed.")], {
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
			// The job is gone already.
		}
	}
});
