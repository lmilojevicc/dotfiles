/**
 * bash-jobs: Pi's bash tool, except that no command can hold the agent for long. A command still
 * running after a short wait keeps running in the background as a job; the model gets its output so
 * far, a message when it exits, and `jobs` / `wait %N` / `kill %N` across bash calls.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	formatDuration,
	type JobControl,
	listJobs,
	parseJobControl,
	quote,
	runningJobsSection,
	runningReport,
} from "./control.ts";
import { type Job, JobTable, removeStaleTables, runCommand } from "./jobs.ts";

function secondsFromEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long a command may hold the agent before it moves to the background. */
const WAIT_SECONDS = secondsFromEnv("PI_BASH_WAIT_SECONDS", 30);
/** Longest `wait %N` a timeout can ask for. */
const MAX_WAIT_SECONDS = 600;
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
const PROMPT_SECTION = "background_jobs";
const STOP_SIGNALS = new Set<NodeJS.Signals>(["SIGTERM", "SIGKILL", "SIGINT", "SIGQUIT"]);
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

/** The highest job number used earlier in this session, so new jobs never reuse a number the model has seen. */
function highestJobId(ctx: ExtensionContext): number {
	let highest = 0;
	for (const entry of ctx.sessionManager.getEntries() as Array<Record<string, any>>) {
		const id =
			entry.type === "custom_message"
				? entry.customType === MESSAGE_TYPE
					? entry.details?.id
					: undefined
				: entry.message?.details?.job?.id;
		if (typeof id === "number" && id > highest) highest = id;
	}
	return highest;
}

function textResult(text: string, isError = false): AgentToolResult<undefined> {
	return {
		content: [{ type: "text", text }],
		details: undefined,
		isError,
		structuredContent: { output: text, truncated: false, exit_code: isError ? 1 : 0, wall_time_seconds: 0 },
	};
}

function seconds(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

export default function bashJobs(pi: ExtensionAPI): void {
	if (process.platform === "win32") return;

	const base = createBashToolDefinition(process.cwd());
	const parameters = Type.Object({
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(
			Type.Number({
				description: `Kill the command after this many seconds, even after it moves to the background (optional, no default; leave it unset for servers). With \`wait %N\`: how long to wait (default ${WAIT_SECONDS}).`,
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					`Run the command in the background and return after about 1s, with any startup error, instead of waiting ${WAIT_SECONDS}s first; for servers, watchers and long builds. You get a message when it exits.`,
			}),
		),
	});
	type Params = Static<typeof parameters>;

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
			table.nextId = highestJobId(ctx) + 1;
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

	function withNotice(result: AgentToolResult<unknown>, job: Job, mode: string): AgentToolResult<unknown> {
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		const output = text === "(no output)" ? "" : text.trimEnd();
		const notice = backgroundNotice(job, WAIT_SECONDS, mode === "print" || mode === "json");
		const structured = result.structuredContent;
		return {
			...result,
			content: [{ type: "text", text: output ? `${output}\n\n${notice}` : notice }],
			details: { ...(result.details as object | undefined), job: jobDetails(job) },
			structuredContent:
				structured && typeof structured === "object" && !Array.isArray(structured)
					? { ...structured, job: `%${job.id}`, running: true }
					: structured,
		};
	}

	async function waitFor(
		jobs: Job[],
		timeout: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<undefined>) => void) | undefined,
	): Promise<AgentToolResult<undefined>> {
		const limit = Math.min(seconds(timeout) ?? WAIT_SECONDS, MAX_WAIT_SECONDS);
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
			if (job.running) return runningReport(job);
			job.reported = true;
			return endReport(job);
		});
		const stillRunning = jobs.filter((job) => job.running).length;
		if (stillRunning > 0) reports.unshift(`Waited ${limit}s.`);
		return textResult(reports.join("\n\n"), jobs.some(failed));
	}

	async function stop(jobs: Job[], signal: NodeJS.Signals): Promise<AgentToolResult<undefined>> {
		const lines = await Promise.all(
			jobs.map(async (job) => {
				if (!job.running) return `Job %${job.id} ${quote(job.label)} already ${endSummary(job)}.`;
				if (!STOP_SIGNALS.has(signal)) {
					job.signal(signal);
					return `Sent ${signal} to job %${job.id} ${quote(job.label)}.`;
				}
				job.watchers++;
				try {
					await job.stop("stopped", signal);
				} finally {
					job.watchers--;
				}
				return `Stopped job %${job.id} ${quote(job.label)}.`;
			}),
		);
		return textResult(lines.join("\n"));
	}

	async function control(
		table: JobTable,
		request: JobControl,
		timeout: number | undefined,
		signal: AbortSignal | undefined,
		onUpdate: ((partial: AgentToolResult<undefined>) => void) | undefined,
	): Promise<AgentToolResult<undefined>> {
		if (request.kind === "jobs") return textResult(listJobs([...table.jobs.values()]));
		const ids = request.ids === "all" ? table.running().map((job) => job.id) : request.ids;
		const missing = ids.filter((id) => !table.get(id));
		if (missing.length > 0) {
			const list = listJobs([...table.jobs.values()]);
			return textResult(`${request.kind}: ${missing.map((id) => `%${id}`).join(", ")}: no such job.\n${list}`, true);
		}
		const jobs = ids.map((id) => table.get(id) as Job);
		if (request.kind === "kill") return stop(jobs, request.signal);
		if (jobs.length === 0) return textResult("No background jobs are running.");
		return waitFor(jobs, timeout, signal, onUpdate);
	}

	pi.registerTool({
		...base,
		description: `${base.description.replace(/\s*Optionally provide a timeout in seconds\.\s*$/, "")} A command still running after ${WAIT_SECONDS}s keeps running in the background as a job and you get its output so far. background: true returns after about 1s instead; use it for servers, watchers and long builds. Optionally provide a timeout in seconds to kill the command, even after it moves to the background.`,
		promptGuidelines: [
			`A bash command still running after ${WAIT_SECONDS}s keeps running in the background as a job (%1, %2, ...) and you get its output so far; when it exits you get a message with its result. Start servers, watchers and long builds with background: true; otherwise you wait ${WAIT_SECONDS}s before you get control back.`,
			"Don't sleep or poll to wait for a job to finish; keep working meanwhile. If your answer depends on a job's result, run `wait %N` before you answer. End your turn with jobs still running only when they should outlive it, like a server the user wants left up.",
			"To check that a server you started is ready, use one bounded check, such as `timeout 30 sh -c 'until curl -sf localhost:3000 >/dev/null; do sleep 1; done'`.",
			`Bash job control reaches the background jobs of earlier calls: \`jobs\` lists them, \`wait %N\` waits for one, \`kill %N\` stops it. Run on its own, \`wait %N\` waits up to ${WAIT_SECONDS}s (or timeout seconds) and returns the job's last output.`,
			...(base.promptGuidelines ?? []),
		],
		parameters,
		outputSchema: Type.Object({
			...(base.outputSchema as ReturnType<typeof Type.Object>).properties,
			job: Type.Optional(Type.String({ description: "Background job (`%N`) the command now runs as" })),
			running: Type.Optional(Type.Boolean({ description: "The command is still running in the background" })),
		}),
		// Models trained on other agents name the flag differently or send strings.
		prepareArguments(args: unknown): Params {
			if (!args || typeof args !== "object") return args as Params;
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
			return input as Params;
		},
		async execute(toolCallId, params: Params, signal, onUpdate, ctx) {
			const current = attach(ctx);
			const request = parseJobControl(params.command);
			if (request) return control(current.table, request, params.timeout, signal, onUpdate);

			const label = params.command.trim();
			const duplicate = current.table.findRunning(label, ctx.cwd);
			if (duplicate) {
				return textResult(
					`Not run: ${quote(label)} is already running as job %${duplicate.id} (for ${formatDuration(Date.now() - duplicate.startedAt)}). Its output goes to ${duplicate.logPath}. Run \`kill %${duplicate.id}\` first to start it again.`,
				);
			}

			let job: Job | undefined;
			const operations: BashOperations = {
				async exec(command, cwd, { onData, signal: execSignal, timeout, env }) {
					if (!existsSync(cwd)) throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
					const shell = getShellConfig(current.shellPath);
					const result = await runCommand(current.table, {
						command: current.table.withJobControl(command),
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
			if (verb !== "kill" && verb !== "stop") {
				ctx.ui.notify(listJobs([...current.table.jobs.values()]), "info");
				return;
			}
			const job = current.table.get(Number(target?.replace(/^%/, "")));
			if (!job?.running) {
				ctx.ui.notify(`No running job ${target ?? ""}`.trim(), "warning");
				return;
			}
			job.watchers++;
			try {
				await job.stop("stopped");
			} finally {
				job.watchers--;
			}
			// The model learns about it on its next turn without being woken for it.
			pi.sendMessage(
				{
					customType: MESSAGE_TYPE,
					content: `The user stopped background job %${job.id} ${quote(job.label)}.`,
					display: true,
					details: jobDetails(job),
				},
				{ deliverAs: "nextTurn" },
			);
			ctx.ui.notify(`Stopped job %${job.id}`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		attach(ctx);
	});

	// A named section, so Pi sends the model only the change when jobs start or end, and drops it when none run.
	pi.on("before_agent_start", (event, ctx) => {
		const section = runningJobsSection(attach(ctx).table.running());
		if (section) event.systemPromptOptions.sections[PROMPT_SECTION] = section;
		else delete event.systemPromptOptions.sections[PROMPT_SECTION];
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
