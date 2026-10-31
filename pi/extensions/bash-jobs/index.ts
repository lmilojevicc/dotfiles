/**
 * bash-jobs: Pi's bash tool, except that no command can hold the agent for long. A command still
 * running after a short wait keeps running in the background as a job; the model gets its output so
 * far, keeps working, and gets a message when the job exits. The `jobs` tool lists jobs, shows a
 * job's new output, waits for one or stops it.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type BashOperations,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getShellConfig,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	backgroundNotice,
	cleanOutput,
	endReport,
	endSummary,
	failed,
	leadingSleepSeconds,
	listJobs,
	MIN_REFUSED_SLEEP_SECONDS,
	progressReport,
	quote,
} from "./format.ts";
import { type Job, JobTable, removeStaleTables, runCommand } from "./jobs.ts";

function secondsFromEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long a command may hold the agent before it moves to the background. */
const WAIT_SECONDS = secondsFromEnv("PI_BASH_WAIT_SECONDS", 10);
/** How long `jobs wait` waits by default, and the most a timeout can ask for. */
const DEFAULT_JOB_WAIT_SECONDS = 30;
const MAX_JOB_WAIT_SECONDS = 600;
/** `background: true` still waits this long, so a command that fails at once reports it inline. */
const START_CHECK_MS = 1000;

/** Commands run without a terminal; keep the ones that would open an editor or prompt from waiting forever. */
const NON_INTERACTIVE_ENV = {
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	EDITOR: "true",
	VISUAL: "true",
	GIT_TERMINAL_PROMPT: "0",
	PAGER: "cat",
	GIT_PAGER: "cat",
	PYTHONUNBUFFERED: "1",
};

const MESSAGE_TYPE = "bash-job";
const TABLES = Symbol.for("pi.bash-jobs.tables");

/** Job tables by session id, kept on globalThis so running jobs survive /reload. */
function tables(): Map<string, JobTable> {
	const shared = globalThis as { [TABLES]?: Map<string, JobTable> };
	shared[TABLES] ??= new Map();
	return shared[TABLES];
}

interface JobDetails {
	id: number;
	label: string;
	pid: number | undefined;
	logPath: string;
	reason: Job["reason"];
	running: boolean;
	failed: boolean;
	exitCode: number | null;
	signal: string | null;
}

function jobDetails(job: Job): JobDetails {
	return {
		id: job.id,
		label: job.label,
		pid: job.pid,
		logPath: job.logPath,
		reason: job.reason,
		running: job.running,
		failed: failed(job),
		exitCode: job.exitCode,
		signal: job.exitSignal,
	};
}

function textResult(text: string, isError = false): AgentToolResult<undefined> {
	return { content: [{ type: "text", text }], details: undefined, isError };
}

/** A bash call that ran nothing, with the structured fields the bash tool's output schema promises. */
function refusal(text: string): AgentToolResult<undefined> {
	return {
		...textResult(text, true),
		structuredContent: { output: text, truncated: false, exit_code: 1, wall_time_seconds: 0 },
	};
}

function seconds(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

export default function bashJobs(pi: ExtensionAPI): void {
	if (process.platform === "win32") return;

	const base = createBashToolDefinition(process.cwd());
	const bashParameters = Type.Object({
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(
			Type.Number({
				description:
					"Kill the command after this many seconds, even after it moves to the background (optional, no default; leave it unset for servers).",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description: `Run the command in the background and return after about 1s, with any startup error, instead of waiting ${WAIT_SECONDS}s first; for servers, watchers and long builds. You get a message when it exits.`,
			}),
		),
	});
	type BashParams = Static<typeof bashParameters>;

	const jobsParameters = Type.Object({
		action: StringEnum(["list", "output", "wait", "kill"] as const, {
			description:
				"list: every job and its state. output: what a job printed since you last looked. wait: wait for a job (or, without id, every running job) to exit. kill: stop a job.",
		}),
		id: Type.Optional(Type.Number({ description: "Job number; needed for output and kill" })),
		timeout: Type.Optional(
			Type.Number({
				description: `For wait: give up after this many seconds (default ${DEFAULT_JOB_WAIT_SECONDS}, at most ${MAX_JOB_WAIT_SECONDS}); the job keeps running.`,
			}),
		),
	});
	type JobsParams = Static<typeof jobsParameters>;

	interface State {
		id: string;
		table: JobTable;
		ctx: ExtensionContext;
		shellPath?: string;
		commandPrefix?: string;
	}
	let state: State | undefined;

	function attach(ctx: ExtensionContext): State {
		const id = ctx.sessionManager.getSessionId();
		if (state?.id === id) {
			state.ctx = ctx;
			return state;
		}
		let table = tables().get(id);
		if (!table) {
			// One directory per process: a restarted Pi on the same session must not share or delete it.
			const root = join(tmpdir(), "pi-bash-jobs");
			removeStaleTables(root);
			table = new JobTable(join(root, `${id.replace(/[^\w.-]/g, "_")}-${process.pid}`));
			tables().set(id, table);
		}
		let settings: SettingsManager | undefined;
		try {
			settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
		} catch {
			// Fall back to Pi's default shell.
		}
		state = {
			id,
			table,
			ctx,
			shellPath: settings?.getShellPath(),
			commandPrefix: settings?.getShellCommandPrefix(),
		};
		table.bind({ ended: notify, changed: showStatus });
		return state;
	}

	/** A job ended that the model did not wait for or stop: tell it, steering a running turn or starting one. */
	function notify(job: Job): void {
		if (job.reported) return;
		job.reported = true;
		const ctx = state?.ctx;
		// After a print or JSON run has finished, no one would read a new turn.
		if ((ctx?.mode === "print" || ctx?.mode === "json") && ctx.isIdle()) return;
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: endReport(job, "Background job"), display: true, details: jobDetails(job) },
			{ triggerTurn: true },
		);
	}

	function showStatus(): void {
		if (state?.ctx.mode !== "tui") return;
		const count = state.table.running().length;
		state.ctx.ui.setStatus("bash-jobs", count ? `${count} background job${count === 1 ? "" : "s"}` : undefined);
	}

	/** Text for the user, such as the `/jobs` answer: shown in the transcript without waking the agent. */
	function showToUser(text: string, details?: JobDetails): void {
		pi.sendMessage({ customType: MESSAGE_TYPE, content: text, display: true, details }, { triggerTurn: false });
	}

	function withNotice<T>(result: AgentToolResult<T>, job: Job, mode: string): AgentToolResult<T> {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		const output = text === "(no output)" ? "" : text.trimEnd();
		const notice = backgroundNotice(job, WAIT_SECONDS, mode === "print" || mode === "json");
		const structured = result.structuredContent;
		return {
			...result,
			content: [{ type: "text", text: output ? `${output}\n\n${notice}` : notice }],
			details: { ...(result.details as object | undefined), job: jobDetails(job) } as T,
			structuredContent:
				structured && typeof structured === "object" && !Array.isArray(structured)
					? { ...structured, job: job.id, running: true }
					: structured,
		};
	}

	async function waitFor(
		jobs: Job[],
		timeout: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<undefined>) => void) | undefined,
	): Promise<AgentToolResult<undefined>> {
		const limit = Math.min(seconds(timeout) ?? DEFAULT_JOB_WAIT_SECONDS, MAX_JOB_WAIT_SECONDS);
		for (const job of jobs) job.watchers++;
		let shown = "";
		const progress =
			onUpdate && jobs.length === 1
				? setInterval(() => {
						const tail = cleanOutput(jobs[0].tail(4096), 20);
						if (tail === shown) return;
						shown = tail;
						onUpdate({ content: [{ type: "text", text: tail }], details: undefined });
					}, 1000)
				: undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				const onAbort = () => {
					clearTimeout(timer);
					reject(new Error("Wait aborted"));
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, limit * 1000);
				if (signal?.aborted) return onAbort();
				signal?.addEventListener("abort", onAbort, { once: true });
				void Promise.all(jobs.map((job) => job.ended)).then(() => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					resolve();
				});
			});
		} finally {
			clearInterval(progress);
			for (const job of jobs) job.watchers--;
		}
		const reports = jobs.map((job) => {
			if (job.running) return progressReport(job);
			job.reported = true;
			return endReport(job);
		});
		if (jobs.some((job) => job.running)) reports.unshift(`Waited ${limit}s; you still get a message when it exits.`);
		return textResult(reports.join("\n\n"), jobs.some(failed));
	}

	async function stop(job: Job): Promise<string> {
		if (!job.running) return `Job ${job.id} ${quote(job.label)} already ${endSummary(job)}.`;
		job.watchers++;
		try {
			await job.stop("stopped");
		} finally {
			job.watchers--;
		}
		return `Stopped job ${job.id} ${quote(job.label)}.`;
	}

	pi.registerTool({
		...base,
		description: `${base.description.replace(/\s*Optionally provide a timeout in seconds\.\s*$/, "")} A command still running after ${WAIT_SECONDS}s keeps running in the background as a job: you get its output so far, keep working, and get a message when it exits. background: true returns after about 1s instead; use it for servers, watchers and long builds. Optionally provide a timeout in seconds to kill the command, even after it moves to the background.`,
		promptGuidelines: [
			`A bash command still running after ${WAIT_SECONDS}s keeps running in the background as a numbered job and you get its output so far; when it exits you get a message with its result. Start servers, watchers and long builds with background: true.`,
			"Don't sleep or poll to wait for a job; keep working on something else, and the exit message comes on its own. Use the jobs tool to see a job's new output (output), wait for it when your next step needs its result (wait), stop it (kill) or see every job (list). End your turn with jobs still running only when they should outlive it, like a server the user wants left up.",
			"To check that a server you started is ready, use one bounded check, such as `timeout 30 sh -c 'until curl -sf localhost:3000 >/dev/null; do sleep 1; done'`.",
			...(base.promptGuidelines ?? []),
		],
		parameters: bashParameters,
		outputSchema: Type.Object({
			...(base.outputSchema as ReturnType<typeof Type.Object>).properties,
			job: Type.Optional(Type.Number({ description: "Background job number the command now runs as" })),
			running: Type.Optional(Type.Boolean({ description: "The command is still running in the background" })),
		}),
		// Models trained on other agents name the flag differently or send strings.
		prepareArguments(args: unknown): BashParams {
			if (!args || typeof args !== "object") return args as BashParams;
			const input = { ...(args as Record<string, unknown>) };
			if (typeof input.command !== "string" && typeof input.cmd === "string") input.command = input.cmd;
			delete input.cmd;
			for (const alias of ["run_in_background", "is_background", "runInBackground"]) {
				if (input.background === undefined && alias in input) input.background = input[alias];
				delete input[alias];
			}
			if (typeof input.background === "string") input.background = input.background.trim().toLowerCase() === "true";
			if (input.background === null) delete input.background;
			if (typeof input.timeout === "string" && input.timeout.trim() !== "" && Number.isFinite(Number(input.timeout))) {
				input.timeout = Number(input.timeout);
			}
			if (input.timeout === null) delete input.timeout;
			return input as BashParams;
		},
		async execute(toolCallId, params: BashParams, signal, onUpdate, ctx) {
			const current = attach(ctx);
			const label = params.command.trim();

			const slept = params.background ? undefined : leadingSleepSeconds(label);
			if (slept !== undefined && slept >= MIN_REFUSED_SLEEP_SECONDS) {
				const running = current.table.running();
				return refusal(
					[
						`Not run: \`sleep ${slept}\` would only hold you up. Background jobs send you a message when they exit, so keep working instead of waiting.`,
						running.length > 0
							? `To block until one is done, use the jobs tool's wait action; to see its progress, output. Running: ${running.map((job) => `${job.id} ${quote(job.label, 40)}`).join(", ")}.`
							: "No background jobs are running. If you are waiting on something outside them, use one bounded check such as `timeout 60 sh -c 'until <check>; do sleep 1; done'`.",
					].join("\n"),
				);
			}

			let job: Job | undefined;
			const operations: BashOperations = {
				async exec(command, cwd, { onData, signal: execSignal, timeout, env }) {
					if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
					const shell = getShellConfig(current.shellPath);
					const result = await runCommand(current.table, {
						command,
						label,
						cwd,
						env: { ...env, ...NON_INTERACTIVE_ENV },
						shell: shell.shell,
						args: shell.args,
						commandFromStdin: shell.commandTransport === "stdin",
						timeoutSeconds: seconds(timeout),
						waitMs: params.background ? START_CHECK_MS : WAIT_SECONDS * 1000,
						reason: params.background ? "requested" : "waited",
						signal: execSignal,
						onData,
					});
					if (result.kind === "exited") return { exitCode: result.exitCode };
					job = result.job;
					return { exitCode: job.reason === "leftover" ? job.exitStatus() : 0 };
				},
			};
			const bash = createBashToolDefinition(ctx.cwd, {
				operations,
				commandPrefix: current.commandPrefix,
				shellPath: current.shellPath,
			});
			const result = await bash.execute(
				toolCallId,
				{ command: params.command, timeout: seconds(params.timeout) },
				signal,
				onUpdate,
				ctx,
			);
			return job ? withNotice(result, job, ctx.mode) : result;
		},
	});

	pi.registerTool({
		name: "jobs",
		label: "Jobs",
		description:
			"Manage background jobs from bash: list them, read a job's new output since you last looked, wait for one to exit, or stop one. Jobs report their exit with a message on their own, so use wait only when your next step needs the result.",
		promptSnippet: "List, read, wait for and stop background bash jobs",
		parameters: jobsParameters,
		prepareArguments(args: unknown): JobsParams {
			if (!args || typeof args !== "object") return args as JobsParams;
			const input = { ...(args as Record<string, unknown>) };
			for (const key of ["id", "timeout"]) {
				const value = input[key];
				if (typeof value === "string") {
					const number = Number(value.trim().replace(/^%/, ""));
					if (value.trim() !== "" && Number.isFinite(number)) input[key] = number;
				}
				if (input[key] === null) delete input[key];
			}
			return input as JobsParams;
		},
		async execute(_toolCallId, params: JobsParams, signal, onUpdate, ctx) {
			const { table } = attach(ctx);
			if (params.action === "list") return textResult(listJobs([...table.jobs.values()]));

			if (params.id === undefined) {
				if (params.action !== "wait") return textResult(`${params.action} needs the job's id.\n${listJobs([...table.jobs.values()])}`, true);
				const running = table.running();
				if (running.length === 0) return textResult("No background jobs are running.");
				return waitFor(running, params.timeout, signal, onUpdate);
			}
			const job = table.get(params.id);
			if (!job) return textResult(`No job ${params.id}.\n${listJobs([...table.jobs.values()])}`, true);

			if (params.action === "kill") return textResult(await stop(job));
			if (params.action === "wait") return waitFor([job], params.timeout, signal, onUpdate);
			if (job.running) return textResult(progressReport(job));
			job.reported = true;
			return textResult(endReport(job), failed(job));
		},
	});

	pi.registerMessageRenderer<JobDetails>(MESSAGE_TYPE, (message, { expanded, outputPad }, theme) => {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const [first = "", ...rest] = text.split("\n");
		const head = theme.fg(message.details?.failed ? "error" : "success", first);
		const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
		box.addChild(new Text(expanded ? [head, ...rest.map((line) => theme.fg("toolOutput", line))].join("\n") : head, 0, 0));
		return box;
	});

	pi.registerCommand("jobs", {
		description: "List background bash jobs; /jobs kill <n> stops one",
		handler: async (args, ctx) => {
			const current = attach(ctx);
			const [verb, target] = args.trim().split(/\s+/);
			// BB runs Pi over RPC and drops notifications, so outside the TUI the answer goes into the transcript.
			const tui = ctx.mode === "tui";
			const answer = (text: string, level: "info" | "warning" = "info") =>
				tui ? ctx.ui.notify(text, level) : showToUser(text);
			if (verb !== "kill" && verb !== "stop") return answer(listJobs([...current.table.jobs.values()]));
			const job = current.table.get(Number(target?.replace(/^%/, "")));
			if (!job?.running) return answer(`No running job ${target ?? ""}`.trim(), "warning");
			await stop(job);
			const stopped = `The user stopped background job ${job.id} ${quote(job.label)}.`;
			if (tui) {
				// The model learns about it on its next turn without being woken for it.
				pi.sendMessage(
					{ customType: MESSAGE_TYPE, content: stopped, display: true, details: jobDetails(job) },
					{ deliverAs: "nextTurn" },
				);
				ctx.ui.notify(`Stopped job ${job.id}`, "info");
			} else {
				showToUser(stopped, jobDetails(job));
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		attach(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		const current = state;
		state = undefined;
		if (!current) return;
		if (event.reason === "reload") {
			// The next runtime binds the same table on its session_start; jobs that end meanwhile are queued.
			current.table.bind(undefined);
			return;
		}
		tables().delete(current.id);
		await current.table.stopAll();
		current.table.dispose();
	});
}
