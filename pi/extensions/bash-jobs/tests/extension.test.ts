/**
 * End to end through a real Pi session: the faux model makes the tool calls, the extension replaces
 * the bash tool, and real processes run. PI_BASH_WAIT_SECONDS is 1 (see tests/setup.mjs).
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

/** A session manager backed by a real file, which is what a restarted Pi reads. */
function sessionFile(): { dir: string; manager: SessionManager } {
	const dir = mkdtempSync(join(tmpdir(), "session-"));
	return { dir, manager: SessionManager.create(dir, join(dir, "sessions")) };
}

function bash(args: Record<string, unknown>): FauxResponseStep {
	return fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" });
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

/** A faux reply that records the background_jobs section the model has, folding later system updates. */
function reply(text: string, seen: Array<string | undefined>): FauxResponseStep {
	return (context) => {
		let section: string | undefined;
		for (const message of context.messages) {
			const sections = message.role === "system" ? message.sections : undefined;
			if (sections && "background_jobs" in sections) section = sections.background_jobs ?? undefined;
		}
		seen.push(section);
		return fauxAssistantMessage(text);
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
		assert.match(text(result), /^begin\n\nStill running after 1s, so it now runs in the background as job %1 \(pid \d+\)/);
		assert.match(text(result), /`wait %1` waits for it and `kill %1` stops it/);
		assert.equal(result.details.job.id, 1);

		await until(() => h.calls() === 3 && h.session.isStreaming === false);
		const [notice] = notices(h.session);
		assert.match(notice, /^Background job %1 `echo begin; sleep 2; echo finish` exited with code 0 after 2s\.\nLast output:\nbegin\nfinish\nFull output: /);
	} finally {
		await h.close();
	}
});

test("job control works across calls, and a stopped job sends no message", async () => {
	const structured: unknown[] = [];
	const h = await harness([
		bash({ command: "sleep 30", run_in_background: "true" }),
		bash({ command: "sleep 30", background: true }),
		bash({ command: "jobs" }),
		bash({ command: "kill %1" }),
		bash({ command: "jobs" }),
		bash({ command: "wait %7" }),
		fauxAssistantMessage("Done."),
	], { structuredResults: structured });
	try {
		await h.session.prompt("start the server");
		const results = toolResults(h.session).map(text);
		assert.match(results[0], /^Started in the background as job %1 \(pid \d+\)\. Its output goes to .*job-1\.log\./);
		assert.match(results[1], /^Not run: `sleep 30` is already running as job %1/);
		// Nothing ran, so the call reports a failure like `wait %7` for a missing job.
		assert.equal(toolResults(h.session)[1].isError, true);
		assert.equal((structured[1] as { exit_code?: number } | undefined)?.exit_code, 1, "the structured result reports the failure too");
		assert.match(results[2], /^%1 {2}`sleep 30` {2}running \d+s/);
		assert.equal(results[3], "Stopped job %1 `sleep 30`.");
		assert.match(results[4], /^%1 {2}`sleep 30` {2}was stopped after \d+s/);
		assert.match(results[5], /^wait: %7: no such job\./);
		assert.equal(toolResults(h.session)[5].isError, true);
		await sleep(500);
		assert.equal(h.calls(), 7);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("wait %N returns the result in place of a message", async () => {
	const h = await harness([
		bash({ command: "sleep 1.5; echo ok" }),
		bash({ command: "wait %1" }),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("run it");
		const results = toolResults(h.session).map(text);
		assert.match(results[0], /job %1/);
		assert.match(results[1], /^Job %1 `sleep 1\.5; echo ok` exited with code 0 after 2s\.\nLast output:\nok\n/);
		await sleep(500);
		assert.equal(h.calls(), 3);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("a wait that an aborted turn gives up on still lets the job's message arrive", async () => {
	const h = await harness([
		bash({ command: "sleep 2; echo finished", background: true }),
		bash({ command: "wait %1 && echo waited" }),
		fauxAssistantMessage("Still building."),
	]);
	try {
		const turn = h.session.prompt("build it");
		// The second call waits for %1 from the shell: kill that shell while the job keeps running.
		const jobs = join(tmpdir(), "pi-bash-jobs", `${h.session.sessionManager.getSessionId()}-${process.pid}`);
		await until(() => existsSync(join(jobs, "job-1.waiting")));
		await h.session.abort();
		await turn;
		assert.deepEqual(notices(h.session), []);
		await until(() => notices(h.session).length === 1);
		assert.match(notices(h.session)[0], /^Background job %1 `sleep 2; echo finished` exited with code 0 after \d+s\./);
	} finally {
		await h.close();
	}
});

test("job control also works inside larger commands, without a second report", async () => {
	const h = await harness([
		bash({ command: "sleep 1.4; echo built" }),
		bash({ command: 'wait %1 && echo "after wait"' }),
		bash({ command: "sleep 30", background: true }),
		bash({ command: "kill %2; echo restarted" }),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("build, then restart the server");
		const results = toolResults(h.session).map(text);
		assert.match(results[0], /job %1/);
		assert.equal(results[1], "after wait\n");
		assert.match(results[2], /job %2/);
		assert.equal(results[3], "restarted\n");
		await sleep(500);
		assert.equal(h.calls(), 5);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("the tool text says what the flag saves, that it returns after about 1s, that timeout still kills, when to wait and how to check readiness", async () => {
	let tool: { description?: string; parameters?: any } | undefined;
	let prompt = "";
	const h = await harness([
		(context) => {
			for (const message of context.messages) {
				if (message.role !== "system") continue;
				tool = message.toolsAdded?.find((t) => t.name === "bash") ?? tool;
				prompt += Object.values(message.sections ?? {}).join("\n");
			}
			return fauxAssistantMessage("Done.");
		},
	]);
	try {
		await h.session.prompt("hi");
		const { background, timeout } = tool?.parameters?.properties ?? {};
		assert.match(tool?.description ?? "", /still running after 1s keeps running in the background.*background: true returns after about 1s/s);
		assert.match(tool?.description ?? "", /kill the command, even after it moves to the background\.$/);
		assert.match(background?.description ?? "", /return after about 1s, with any startup error, instead of waiting 1s first/);
		assert.match(timeout?.description ?? "", /even after it moves to the background .*leave it unset for servers/);
		assert.match(prompt, /with background: true; otherwise you wait 1s before you get control back/);
		// Ending the turn is the final answer for subagents and print runs, and their jobs stop with it.
		assert.match(prompt, /If your answer depends on a job's result, run `wait %N` before you answer\./);
		assert.doesNotMatch(prompt, /end your turn if nothing else is left/i);
		assert.match(prompt, /To check that a server you started is ready, use one bounded check, such as `timeout 30 sh -c 'until curl/);
	} finally {
		await h.close();
	}
});

test("the system prompt lists running jobs, and drops the list when none run", async () => {
	const seen: Array<string | undefined> = [];
	const h = await harness([
		reply("Nothing yet.", seen),
		bash({ command: "sleep 30", background: true }),
		reply("Started.", seen),
		reply("Still up.", seen),
		bash({ command: "kill %1" }),
		reply("Stopped.", seen),
		reply("All quiet.", seen),
	]);
	try {
		await h.session.prompt("hi");
		await h.session.prompt("start the server");
		await h.session.prompt("is it up?");
		await h.session.prompt("stop it");
		await h.session.prompt("anything running?");
		const [before, sameRun, nextRun, , after] = seen;
		assert.equal(before, undefined);
		// The list is set when a run starts, so the run that started the job learns of it from the tool result.
		assert.equal(sameRun, undefined);
		assert.match(nextRun ?? "", /^<background_jobs>\nBackground jobs from earlier bash calls are still running:\n%1 {2}`sleep 30` {2}\(pid \d+, output .*job-1\.log\)\n/);
		assert.equal(after, undefined);
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

test("commands run without editors, pagers or credential prompts that need a terminal", async () => {
	const h = await harness([
		bash({ command: "echo $GIT_EDITOR $GIT_SEQUENCE_EDITOR $EDITOR $PAGER $GIT_PAGER $GIT_TERMINAL_PROMPT" }),
		fauxAssistantMessage("Done."),
	]);
	try {
		await h.session.prompt("check");
		assert.equal(text(toolResults(h.session)[0]), "true true true cat cat 0\n");
	} finally {
		await h.close();
	}
});

test("an explicit timeout still kills the command", async () => {
	const h = await harness([bash({ command: "sleep 30", timeout: "0.5" }), fauxAssistantMessage("Done.")]);
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
		assert.match(text(result), /This run ends when you finish, and jobs still running then are stopped/);
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
		assert.match(text(listing), /^%1 {2}`sleep 30` {2}running \d+s/);
		await h.session.prompt("/jobs kill 1");
		assert.equal(h.calls(), calls);
		assert.match(notices(h.session).at(-1) ?? "", /^The user stopped background job %1 `sleep 30`\./);
		await h.session.prompt("/jobs");
		assert.match(notices(h.session).at(-1) ?? "", /^%1 {2}`sleep 30` {2}was stopped after \d+s/);
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
		assert.match(notified.at(-1) ?? "", /^%1 {2}`sleep 30` {2}running \d+s/);
		assert.deepEqual(notices(h.session), []);
	} finally {
		await h.close();
	}
});

test("a shutdown with jobs running tells the next process on the session file", async () => {
	const { dir, manager } = sessionFile();
	const file = manager.getSessionFile();
	assert.ok(file);
	const h = await harness([bash({ command: "sleep 30", background: true }), fauxAssistantMessage("Started.")], {
		dir,
		sessionManager: manager,
	});
	let pid: number | undefined;
	try {
		await h.session.prompt("start the server");
		pid = toolResults(h.session)[0].details.job.pid;
	} finally {
		// BB restarts Pi on a model, thinking-level or environment change, keeping the session file.
		await h.close("new");
	}
	assert.ok(!groupAlive(pid));

	// The message is in the file, not only in the dead process.
	const entries = SessionManager.open(file).getEntries() as Array<Record<string, any>>;
	const stopped = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "bash-job");
	assert.equal(stopped.length, 1);
	assert.match(
		text(stopped[0]),
		/^This background job was stopped because the Pi process ended:\n%1 {2}`sleep 30` {2}\(pid \d+, output .*job-1\.log\)\nIt is gone, so `wait %N` and `kill %N` answer "no such job"/,
	);

	// And the next process sends it to the model, without reusing %1 for a new job.
	const seen: string[] = [];
	const next = await harness(
		[
			(context) => {
				for (const message of context.messages) seen.push(text(message as { content: unknown }));
				return fauxAssistantMessage("Good to know.");
			},
			bash({ command: "sleep 5", background: true }),
			fauxAssistantMessage("Started."),
		],
		{ dir, sessionManager: SessionManager.open(file) },
	);
	try {
		await next.session.prompt("what happened to the server?");
		assert.ok(seen.some((message) => /stopped because the Pi process ended/.test(message)));
		await next.session.prompt("start another");
		assert.equal(toolResults(next.session).at(-1)?.details.job.id, 2);
	} finally {
		await next.close();
	}
});

test("a shutdown with no running jobs leaves no message behind", async () => {
	const { dir, manager } = sessionFile();
	const h = await harness(
		[bash({ command: "sleep 30", background: true }), bash({ command: "kill %1" }), fauxAssistantMessage("Done.")],
		{ dir, sessionManager: manager },
	);
	try {
		await h.session.prompt("start it, then stop it");
	} finally {
		await h.close();
	}
	const entries = (SessionManager.open(manager.getSessionFile() as string).getEntries() as Array<Record<string, any>>).filter(
		(entry) => entry.type === "custom_message",
	);
	assert.deepEqual(entries, []);
});

test("a reload keeps the jobs and writes no shutdown message", async () => {
	const { dir, manager } = sessionFile();
	const h = await harness([bash({ command: "sleep 30", background: true }), fauxAssistantMessage("Started.")], {
		dir,
		sessionManager: manager,
	});
	let pid: number | undefined;
	try {
		await h.session.prompt("start the server");
		pid = toolResults(h.session)[0].details.job.pid;
	} finally {
		await h.close("reload");
	}
	try {
		assert.ok(groupAlive(pid));
		const entries = (SessionManager.open(manager.getSessionFile() as string).getEntries() as Array<Record<string, any>>).filter(
			(entry) => entry.type === "custom_message",
		);
		assert.deepEqual(entries, []);
	} finally {
		try {
			process.kill(-(pid as number), "SIGKILL");
		} catch {
			// The job is gone already.
		}
	}
});
