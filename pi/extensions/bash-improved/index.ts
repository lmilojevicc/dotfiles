/**
 * bash-improved: Pi's own bash tool, with Claude Code's background tasks. A command started with
 * `run_in_background`, or still running after a short wait, keeps running as a background task; the
 * model gets its output so far, keeps working, and gets a message when the task exits. The model
 * manages tasks with the `tasks` command in bash itself (answered by this extension, so it shows as an
 * ordinary bash command everywhere), and the user with `/tasks`.
 */
import {
	chmodSync,
	existsSync,
	type FSWatcher,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
	type Control,
	parseControl,
	SHIM,
	startsWithCompoundTasks,
	taskId,
	USAGE,
} from "./control.ts";
import {
	backgroundNotice,
	batchReport,
	cleanOutput,
	endReport,
	endSummary,
	failed,
	formatDuration,
	leadingSleepSeconds,
	listTasks,
	MIN_REFUSED_SLEEP_SECONDS,
	progressReport,
	quote,
	status,
	title,
} from "./format.ts";
import {
	DEFAULT_READY_SECONDS,
	describeReady,
	parseReady,
	type ReadyOutcome,
	type ReadySpec,
	waitReady,
} from "./ready.ts";
import { INTERRUPT_POLL_MS, runCommand, type Task, TaskTable, removeStaleTables } from "./tasks.ts";

function secondsFromEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long a command may hold the agent before it moves to the background. */
const WAIT_SECONDS = secondsFromEnv("PI_BASH_WAIT_SECONDS", 10);
/** `run_in_background` still waits this long, so a command that fails at once reports it inline. */
const START_CHECK_MS = 1000;
/** Running tasks the widget names one per line before it sums up the rest. */
const WIDGET_LINES = 3;
/** A timeout at most this much past the wait keeps the command in the foreground until it ends or is killed. */
const SHORT_TIMEOUT_SLACK_SECONDS = 5;
/** Tasks that end within this long of the first one are reported in one message. */
const BATCH_MS = 500;

/**
 * Commands run without a terminal; keep the ones that would open an editor, pager or prompt from
 * waiting forever, and quiet the progress bars and nags that only fill the output. CI, TERM, NO_COLOR
 * and the locale are left alone: they change how tests and snapshots behave.
 */
const NON_INTERACTIVE_ENV = {
	// Editors.
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	EDITOR: "true",
	VISUAL: "true",
	// Pagers.
	PAGER: "cat",
	GIT_PAGER: "cat",
	MANPAGER: "cat",
	SYSTEMD_PAGER: "cat",
	GH_PAGER: "cat",
	BAT_PAGER: "cat",
	DELTA_PAGER: "cat",
	AWS_PAGER: "",
	LESS: "FRX",
	// Credential and confirmation prompts.
	GIT_TERMINAL_PROMPT: "0",
	GCM_INTERACTIVE: "never",
	SSH_ASKPASS: "false",
	GH_PROMPT_DISABLED: "1",
	DEBIAN_FRONTEND: "noninteractive",
	PIP_NO_INPUT: "1",
	TF_INPUT: "0",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
	COMPOSER_NO_INTERACTION: "1",
	// Progress bars and nags.
	npm_config_fund: "false",
	npm_config_audit: "false",
	npm_config_update_notifier: "false",
	PIP_DISABLE_PIP_VERSION_CHECK: "1",
	// Output reaches the log as it is written.
	PYTHONUNBUFFERED: "1",
};

const MESSAGE_TYPE = "background-task";
const WIDGET_KEY = "bash-improved";
const TABLES = Symbol.for("pi.bash-improved.tables");
/** Where every Pi keeps its task directories; BB's pi-tasks plugin reads them. */
export const TASKS_ROOT = process.env.PI_BASH_TASKS_DIR || join(tmpdir(), "pi-bash-tasks");
/** In a task directory: the tasks for other programs to read, and their stop requests (`stop-<id>`). */
const STATE_FILE = "state.json";
const STOP_PREFIX = "stop-";

/** Task tables by session id, kept on globalThis so running tasks survive /reload. */
function tables(): Map<string, TaskTable> {
	const shared = globalThis as { [TABLES]?: Map<string, TaskTable> };
	shared[TABLES] ??= new Map();
	return shared[TABLES];
}

interface TaskDetails {
	id: number;
	label: string;
	description: string | undefined;
	pid: number | undefined;
	logPath: string;
	reason: Task["reason"];
	status: ReturnType<typeof status>;
	failed: boolean;
	exitCode: number | null;
	signal: string | null;
	startedAt: number;
	endedAt: number | null;
}

function taskDetails(task: Task): TaskDetails {
	return {
		id: task.id,
		label: task.label,
		description: task.description,
		pid: task.pid,
		logPath: task.logPath,
		reason: task.reason,
		status: status(task),
		failed: failed(task),
		exitCode: task.exitCode,
		signal: task.exitSignal,
		startedAt: task.startedAt,
		endedAt: task.endedAt ?? null,
	};
}

interface BatchDetails {
	tasks: TaskDetails[];
	failed: boolean;
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

/** `~` and paths relative to the session's directory, as the model writes them. */
function resolveDir(base: string, dir: string): string {
	const expanded =
		dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
	return resolve(base, expanded);
}

/** Copy the first alias present onto `key`, then drop every alias. */
function alias(input: Record<string, unknown>, key: string, names: string[]): void {
	for (const name of names) {
		if (input[key] === undefined && input[name] !== undefined) input[key] = input[name];
		delete input[name];
	}
}

export default function bashImproved(pi: ExtensionAPI): void {
	if (process.platform === "win32") return;

	const base = createBashToolDefinition(process.cwd());
	const bashParameters = Type.Object({
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(
			Type.Number({
				description:
					"Timeout in seconds: kill the command after this long, also once it runs in the background (optional, no default; leave it unset for servers)",
			}),
		),
		run_in_background: Type.Optional(
			Type.Boolean({
				description: `Start the command as a background task right away (returning after about 1s, with any startup error) instead of after ${WAIT_SECONDS}s; for servers, watchers and long builds`,
			}),
		),
		description: Type.Optional(
			Type.String({
				description:
					'What the command does in 5-10 words, e.g. "Run the test suite"; the user sees it while the command runs',
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description:
					"Directory to run the command in, absolute or relative to the session's directory; use it instead of `cd dir && …`",
			}),
		),
		ready: Type.Optional(
			Type.Object(
				{
					port: Type.Optional(
						Type.Number({ description: "Ready once this TCP port accepts connections" }),
					),
					host: Type.Optional(
						Type.String({ description: "Host for the port check (default: 127.0.0.1 and ::1)" }),
					),
					log: Type.Optional(
						Type.String({
							description: "Ready once an output line matches this regular expression",
						}),
					),
					timeout: Type.Optional(
						Type.Number({
							description: `Seconds to wait for readiness (default ${DEFAULT_READY_SECONDS})`,
						}),
					),
				},
				{
					description:
						"For servers: start the command in the background and return once it is ready (every condition given holds), it exits, or the readiness timeout runs out. Implies run_in_background",
				},
			),
		),
	});
	type BashParams = Static<typeof bashParameters>;

	interface State {
		id: string;
		table: TaskTable;
		ctx: ExtensionContext;
		shellPath?: string;
		commandPrefix?: string;
		binDir: string;
		ticker?: NodeJS.Timeout;
		watcher?: FSWatcher;
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
			removeStaleTables(TASKS_ROOT);
			table = new TaskTable(join(TASKS_ROOT, `${id.replace(/[^\w.-]/g, "_")}-${process.pid}`));
			tables().set(id, table);
		}
		const binDir = join(table.dir, "bin");
		try {
			mkdirSync(binDir, { recursive: true, mode: 0o700 });
			writeFileSync(join(binDir, "tasks"), SHIM);
			chmodSync(join(binDir, "tasks"), 0o755);
		} catch {
			// Without the stand-in, `tasks` inside a pipeline is just "command not found".
		}
		let settings: SettingsManager | undefined;
		try {
			settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
				projectTrusted: ctx.isProjectTrusted(),
			});
		} catch {
			// Fall back to Pi's default shell.
		}
		state?.watcher?.close();
		state = {
			id,
			table,
			ctx,
			shellPath: settings?.getShellPath(),
			commandPrefix: settings?.getShellCommandPrefix(),
			binDir,
		};
		state.watcher = watchStopRequests(state);
		table.bind({ ended: notify, changed });
		return state;
	}

	/** Ended tasks waiting to be reported together, and the timer that reports them. */
	let pending: Task[] = [];
	let flushTimer: NodeJS.Timeout | undefined;

	/**
	 * A task ended that the model did not wait for or stop: tell it, steering a running turn or
	 * starting one. Tasks that end close together (a fan-out of builds) share one message.
	 */
	function notify(task: Task): void {
		if (task.reported || pending.includes(task)) return;
		pending.push(task);
		flushTimer ??= setTimeout(flush, BATCH_MS);
	}

	function flush(): void {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		// A task the model read to its end (or waited for) in the meantime needs no message.
		const ended = pending.splice(0).filter((task) => !task.reported);
		if (ended.length === 0) return;
		for (const task of ended) task.reported = true;
		const ctx = state?.ctx;
		// After a print or JSON run has finished, no one would read a new turn.
		if ((ctx?.mode === "print" || ctx?.mode === "json") && ctx.isIdle()) return;
		const details: TaskDetails | BatchDetails =
			ended.length === 1
				? taskDetails(ended[0])
				: { tasks: ended.map(taskDetails), failed: ended.some(failed) };
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: batchReport(ended), display: true, details },
			{ triggerTurn: true },
		);
	}

	function changed(): void {
		showWidget();
		if (state) writeState(state);
	}

	/** The tasks as JSON for other programs, such as BB's pi-tasks plugin; replaced atomically. */
	function writeState(current: State): void {
		const file = join(current.table.dir, STATE_FILE);
		try {
			writeFileSync(
				`${file}.tmp`,
				JSON.stringify({
					version: 1,
					piPid: process.pid,
					sessionId: current.id,
					bbThreadId: process.env.BB_THREAD_ID ?? null,
					cwd: current.ctx.cwd,
					updatedAt: Date.now(),
					tasks: [...current.table.tasks.values()].map(taskDetails),
				}),
				{ mode: 0o600 },
			);
			renameSync(`${file}.tmp`, file);
		} catch {
			// The directory is gone (shutdown); nothing to publish.
		}
	}

	/** Another program asks to stop a task by creating `stop-<id>` in the task directory. */
	function watchStopRequests(current: State): FSWatcher | undefined {
		const handle = (name: string | null) => {
			if (!name?.startsWith(STOP_PREFIX)) return;
			const path = join(current.table.dir, name);
			if (!existsSync(path)) return;
			rmSync(path, { force: true });
			const task = current.table.get(taskId(name.slice(STOP_PREFIX.length)) ?? 0);
			if (task?.running) void userStop(task, current.ctx.mode === "tui");
		};
		try {
			const watcher = watch(current.table.dir, (_event, name) => handle(name));
			watcher.on("error", () => {});
			watcher.unref();
			for (const name of readdirSync(current.table.dir)) handle(name);
			return watcher;
		} catch {
			return undefined;
		}
	}

	/** Claude Code's line above the editor: `Running background command: <description> 5m 57s`. */
	function widgetLines(current: State): string[] | undefined {
		const running = current.table.running();
		if (running.length === 0) return undefined;
		const { theme } = current.ctx.ui;
		const now = Date.now();
		const lines = running
			.slice(0, WIDGET_LINES)
			.map(
				(task) =>
					`${theme.fg("accent", "⏵")} ${theme.fg("muted", "Running background command:")} ${title(task, 70)} ${theme.fg("dim", formatDuration(now - task.startedAt))}`,
			);
		const more = running.length - WIDGET_LINES;
		lines.push(`  ${theme.fg("dim", `${more > 0 ? `+${more} more · ` : ""}/tasks to manage`)}`);
		return lines;
	}

	function showWidget(): void {
		const current = state;
		if (current?.ctx.mode !== "tui") return;
		const lines = widgetLines(current);
		current.ctx.ui.setWidget(WIDGET_KEY, lines);
		if (lines && !current.ticker) {
			current.ticker = setInterval(showWidget, 1000);
			current.ticker.unref();
		} else if (!lines && current.ticker) {
			clearInterval(current.ticker);
			current.ticker = undefined;
		}
	}

	function hideWidget(current: State): void {
		clearInterval(current.ticker);
		current.ticker = undefined;
		if (current.ctx.mode === "tui") current.ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/** Text for the user, such as a `/tasks` answer outside the TUI: shown in the transcript without waking the agent. */
	function showToUser(text: string, details?: TaskDetails): void {
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: text, display: true, details },
			{ triggerTurn: false },
		);
	}

	/** The user stopped a task (`/tasks` or BB): the model learns about it on its next turn, without being woken. */
	async function userStop(task: Task, tui: boolean): Promise<void> {
		await stop(task);
		const stopped = `The user stopped background task ${task.id} ${title(task)}.`;
		if (tui) {
			pi.sendMessage(
				{ customType: MESSAGE_TYPE, content: stopped, display: true, details: taskDetails(task) },
				{ deliverAs: "nextTurn" },
			);
			state?.ctx.ui.notify(`Stopped task ${task.id}`, "info");
		} else {
			showToUser(stopped, taskDetails(task));
		}
	}

	/** The bash result with notes after its output: where the command runs now and whether it is ready. */
	function withNotes<T>(
		result: AgentToolResult<T>,
		notes: {
			task?: Task;
			mode: string;
			interrupted: boolean;
			ready?: { spec: ReadySpec; outcome: ReadyOutcome };
		},
	): AgentToolResult<T> {
		const { task, ready } = notes;
		const lines: string[] = [];
		if (ready) lines.push(readyNote(ready.spec, ready.outcome, task));
		if (task?.running)
			lines.push(
				backgroundNotice(
					task,
					WAIT_SECONDS,
					notes.mode === "print" || notes.mode === "json",
					notes.interrupted,
				),
			);
		if (lines.length === 0) return result;
		const text = result.content.find((part) => part.type === "text")?.text ?? "";
		// Pi's exit status stays the last line, after the notes.
		const status = /\n*(Command exited with code \d+)$/.exec(text);
		const body = status ? text.slice(0, status.index) : text;
		const output = body === "(no output)" ? "" : body.trimEnd();
		const notice = status ? `${lines.join("\n")}\n\n${status[1]}` : lines.join("\n");
		const structured = result.structuredContent;
		const extra = {
			...(task?.running ? { task_id: String(task.id), running: true } : {}),
			...(ready ? { ready: ready.outcome.kind === "ready" } : {}),
		};
		return {
			...result,
			content: [{ type: "text", text: output ? `${output}\n\n${notice}` : notice }],
			details: {
				...(result.details as object | undefined),
				...(task ? { backgroundTask: taskDetails(task) } : {}),
				...(ready ? { ready: ready.outcome.kind } : {}),
			} as T,
			// The guard above admits only non-array JSON objects, so the spread never walks an array.
			structuredContent:
				structured && typeof structured === "object" && !Array.isArray(structured)
					? { ...(structured as Record<string, unknown>), ...extra }
					: structured,
		};
	}

	function readyNote(spec: ReadySpec, outcome: ReadyOutcome, task: Task | undefined): string {
		const what = describeReady(spec);
		if (outcome.kind === "ready") return `Ready: ${what}.`;
		if (outcome.kind === "interrupted")
			return `Stopped waiting for ${what} to handle an incoming message; the server keeps starting.`;
		if (outcome.kind === "exited" || !task?.running) {
			return `Not ready: it ${task ? endSummary(task) : "exited"} before ${what}.`;
		}
		const missing: string[] = [];
		if (spec.port !== undefined && !outcome.portOpen)
			missing.push(`port ${spec.port} does not accept connections`);
		if (spec.log && !outcome.logMatched) missing.push(`no output line matches ${spec.log}`);
		return `NOT ready after ${spec.timeoutSeconds}s: ${missing.join(" and ")}. It keeps running.`;
	}

	/**
	 * Wait for a task to end, the time to run out, or `interrupt` (a message from the user), whichever
	 * comes first; true when interrupted. Abort rejects like Pi's bash.
	 */
	async function waitFor(
		task: Task,
		timeout: number,
		signal: AbortSignal | undefined,
		interrupt?: () => boolean,
	): Promise<boolean> {
		task.watchers++;
		let poll: NodeJS.Timeout | undefined;
		try {
			return await new Promise<boolean>((resolve, reject) => {
				const done = (interrupted: boolean) => {
					clearTimeout(timer);
					clearInterval(poll);
					signal?.removeEventListener("abort", onAbort);
					resolve(interrupted);
				};
				const onAbort = () => {
					clearTimeout(timer);
					clearInterval(poll);
					reject(new Error("aborted"));
				};
				const timer = setTimeout(() => done(false), timeout * 1000);
				if (signal?.aborted) return onAbort();
				signal?.addEventListener("abort", onAbort, { once: true });
				if (interrupt) poll = setInterval(() => interrupt() && done(true), INTERRUPT_POLL_MS);
				void task.ended.then(() => done(false));
			});
		} finally {
			clearInterval(poll);
			task.watchers--;
		}
	}

	async function stop(task: Task): Promise<string> {
		if (!task.running) return `Task ${task.id} ${title(task)} already ${endSummary(task)}.`;
		task.watchers++;
		try {
			await task.stop("stopped");
		} finally {
			task.watchers--;
		}
		return `Stopped task ${task.id} ${title(task)}.`;
	}

	/** Answer a `tasks` command: its output and exit status, as if a program had printed them. */
	async function runControl(
		table: TaskTable,
		control: Control,
		signal: AbortSignal | undefined,
		interrupt?: () => boolean,
	): Promise<{ text: string; exitCode: number }> {
		if (control.verb === "usage")
			return {
				text: control.error ? `${control.error}\n${USAGE}` : USAGE,
				exitCode: control.error ? 2 : 0,
			};
		if (control.verb === "list") return { text: listTasks([...table.tasks.values()]), exitCode: 0 };
		const task = table.get(taskId(control.id) ?? 0);
		if (!task)
			return {
				text: `tasks: no background task ${control.id}\n${listTasks([...table.tasks.values()])}`,
				exitCode: 1,
			};
		if (control.verb === "stop") return { text: await stop(task), exitCode: 0 };
		if (control.verb === "wait" && task.running) {
			const interrupted = await waitFor(task, control.timeout, signal, interrupt);
			if (task.running && interrupted) {
				return {
					text: `Stopped waiting to handle an incoming message; task ${task.id} keeps running and you get a message when it exits.\n\n${progressReport(task)}`,
					exitCode: 0,
				};
			}
			if (task.running) {
				return {
					text: `Waited ${control.timeout}s; it keeps running and you get a message when it exits.\n\n${progressReport(task)}`,
					exitCode: 0,
				};
			}
		}
		if (task.running) return { text: progressReport(task), exitCode: 0 };
		task.reported = true;
		// Like the shell's `wait`, the answer carries the task's own exit status.
		return {
			text: endReport(task),
			exitCode: control.verb === "wait" && failed(task) ? Math.max(1, task.exitStatus()) : 0,
		};
	}

	pi.registerTool({
		...base,
		description: `${base.description.replace(/\s*Optionally provide a timeout in seconds\.\s*$/, "")} A command still running after ${WAIT_SECONDS}s is not killed: it keeps running as a background task, you get its output so far, and you get a message when it exits (unless you waited for it or stopped it). run_in_background: true starts it in the background right away; ready: {port} or {log} also waits until a server is ready. A message from the user moves a waiting command to the background early. A command that starts by sleeping ${MIN_REFUSED_SLEEP_SECONDS}s or more (\`sleep 30 && …\`) is not run: tasks report back on their own. Manage background tasks with the \`tasks\` command, run on its own: \`tasks\` lists them, \`tasks output <id>\` shows new output, \`tasks wait <id> [--timeout <secs>]\` waits for one to exit, \`tasks stop <id>\` stops one. Optionally provide a timeout in seconds to kill the command, also once it runs in the background.`,
		promptGuidelines: [
			`A bash command still running after ${WAIT_SECONDS}s keeps running as a numbered background task and you get its output so far; when it exits you get a message with its result, unless you already waited for it or stopped it. Start servers, watchers and long builds with run_in_background: true, and give long commands a short description.`,
			"Don't sleep or poll to wait for a background task; keep working on something else, and the exit message comes on its own. Run `tasks output <id>` to see what a task printed since you last saw its output, `tasks wait <id>` when your next step needs its result, `tasks stop <id>` to stop it, and `tasks` to list them all. `tasks` only works as a bash command of its own, not in a pipeline. End your turn with tasks still running only when they should outlive it, like a server the user wants left up.",
			'Start a server with `ready`, such as `ready: {port: 3000}` or `ready: {log: "Listening on"}`: the call returns once it is ready, exits, or the readiness timeout runs out, so you need no curl loop.',
			"Use `cwd` to run a command in another directory instead of `cd dir && …`.",
			"Run a check as it is: don't append `; echo $?`, `|| true` or similar, because a task reports its own exit status and that would hide a failure.",
			...(base.promptGuidelines ?? []),
		],
		parameters: bashParameters,
		outputSchema: Type.Object({
			...(base.outputSchema as ReturnType<typeof Type.Object>).properties,
			task_id: Type.Optional(
				Type.String({ description: "ID of the background task the command now runs as" }),
			),
			running: Type.Optional(
				Type.Boolean({ description: "The command is still running in the background" }),
			),
			ready: Type.Optional(
				Type.Boolean({ description: "The readiness condition held before the call returned" }),
			),
		}),
		// Models trained on other agents name the flag differently or send strings.
		prepareArguments(args: unknown): BashParams {
			if (!args || typeof args !== "object") return args as BashParams;
			const input = { ...(args as Record<string, unknown>) };
			alias(input, "command", ["cmd"]);
			alias(input, "run_in_background", ["background", "is_background", "runInBackground"]);
			alias(input, "cwd", ["workdir", "working_directory", "workingDirectory"]);
			if (typeof input.run_in_background === "string")
				input.run_in_background = input.run_in_background.trim().toLowerCase() === "true";
			if (input.run_in_background === null) delete input.run_in_background;
			if (
				typeof input.timeout === "string" &&
				input.timeout.trim() !== "" &&
				Number.isFinite(Number(input.timeout))
			) {
				input.timeout = Number(input.timeout);
			}
			if (input.timeout === null) delete input.timeout;
			if (input.description === null) delete input.description;
			if (input.cwd === null || (typeof input.cwd === "string" && input.cwd.trim() === ""))
				delete input.cwd;
			// Checked in execute, so a bad value gets a clear answer instead of a schema error.
			if (input.ready === null || input.ready === "") delete input.ready;
			else if (typeof input.ready === "string") {
				try {
					input.ready = JSON.parse(input.ready);
				} catch {
					// Left as is; execute explains.
				}
			}
			if (input.ready && typeof input.ready === "object" && !Array.isArray(input.ready)) {
				const ready = { ...(input.ready as Record<string, unknown>) };
				for (const key of ["port", "timeout"]) {
					const value = ready[key];
					if (value === null || value === "") delete ready[key];
					else if (typeof value === "string" && Number.isFinite(Number(value)))
						ready[key] = Number(value);
				}
				for (const key of ["host", "log"]) if (ready[key] === null) delete ready[key];
				input.ready = ready;
			}
			return input as BashParams;
		},
		async execute(toolCallId, params: BashParams, signal, onUpdate, ctx) {
			const current = attach(ctx);
			const label = params.command.trim();
			const control = parseControl(label);
			if (!control && startsWithCompoundTasks(label)) {
				return refusal(
					"Not run: `tasks` works only as a bash command of its own, so here it would do nothing while the rest ran. Run the `tasks` command in one call (such as `tasks stop 1`) and the rest in the next.",
				);
			}
			const ready = control ? undefined : parseReady(params.ready);
			if (typeof ready === "string") return refusal(`Not run: ${ready}.`);
			const background = params.run_in_background === true || ready !== undefined;

			let dir = ctx.cwd;
			if (params.cwd && !control) {
				dir = resolveDir(ctx.cwd, params.cwd.trim());
				let isDir = false;
				try {
					isDir = statSync(dir).isDirectory();
				} catch {
					return refusal(`Not run: the directory ${dir} does not exist.`);
				}
				if (!isDir) return refusal(`Not run: ${dir} is not a directory.`);
			}

			const slept = background || control ? undefined : leadingSleepSeconds(label);
			if (slept !== undefined && slept >= MIN_REFUSED_SLEEP_SECONDS) {
				const running = current.table.running();
				return refusal(
					[
						`Not run: \`sleep ${slept}\` would only hold you up. Background tasks send you a message when they exit, so keep working instead of waiting.`,
						running.length > 0
							? `To block until one is done, run \`tasks wait <id>\`; \`tasks output <id>\` shows its progress. Running: ${running.map((task) => `${task.id} ${title(task, 40)}`).join(", ")}.`
							: "None of your background tasks is still running. If you are waiting on something outside them, use one bounded check such as `timeout 60 sh -c 'until <check>; do sleep 1; done'`.",
					].join("\n"),
				);
			}

			// A message the user sends while the call waits should not wait for the command. One already
			// queued when the call starts does not count: a follow-up is only delivered once the agent
			// stops, so returning early for it would only make the model call again.
			const queuedAtStart = ctx.hasPendingMessages();
			const interrupt = () => !queuedAtStart && ctx.hasPendingMessages();

			const timeoutSeconds = control ? undefined : seconds(params.timeout);
			// A command that its own timeout ends soon after the wait stays in the foreground, instead of
			// becoming a task only to be killed a moment later.
			const shortTimeout =
				timeoutSeconds !== undefined &&
				timeoutSeconds <= WAIT_SECONDS + SHORT_TIMEOUT_SLACK_SECONDS;

			let task: Task | undefined;
			let interrupted = false;
			let readiness: { spec: ReadySpec; outcome: ReadyOutcome } | undefined;
			const operations: BashOperations = {
				async exec(command, _cwd, { onData, signal: execSignal, timeout, env }) {
					if (control) {
						const answer = await runControl(current.table, control, execSignal, interrupt);
						onData(Buffer.from(`${answer.text}\n`));
						return { exitCode: answer.exitCode };
					}
					if (!existsSync(dir))
						throw new Error(
							`Working directory does not exist: ${dir}\nCannot execute bash commands.`,
						);
					const shell = getShellConfig(current.shellPath);
					const result = await runCommand(current.table, {
						command,
						label,
						description: params.description?.trim() || undefined,
						cwd: dir,
						env: {
							...env,
							...NON_INTERACTIVE_ENV,
							PATH: `${current.binDir}:${env?.PATH ?? process.env.PATH ?? ""}`,
						},
						shell: shell.shell,
						args: shell.args,
						commandFromStdin: shell.commandTransport === "stdin",
						timeoutSeconds: seconds(timeout),
						waitMs: background
							? START_CHECK_MS
							: shortTimeout
								? ((timeoutSeconds as number) + 1) * 1000
								: WAIT_SECONDS * 1000,
						reason: background ? "requested" : "waited",
						signal: execSignal,
						interrupt,
						interruptAfterMs: START_CHECK_MS,
						onData,
					});
					if (result.kind === "exited") {
						if (ready) readiness = { spec: ready, outcome: { kind: "exited" } };
						return { exitCode: result.exitCode };
					}
					task = result.task;
					interrupted = result.interrupted;
					if (ready && !interrupted) {
						const outcome = await waitReady(task, ready, { signal: execSignal, interrupt });
						readiness = { spec: ready, outcome };
						// What the server printed while it started, after what the call already showed.
						const { text } = task.unread();
						if (text) onData(Buffer.from(text));
						if (!task.running) return { exitCode: task.exitStatus() };
					} else if (ready) {
						readiness = { spec: ready, outcome: { kind: "interrupted" } };
					}
					return { exitCode: task.reason === "leftover" ? task.exitStatus() : 0 };
				},
			};
			const bash = createBashToolDefinition(dir, {
				operations,
				commandPrefix: current.commandPrefix,
				shellPath: current.shellPath,
			});
			const result = await bash.execute(
				toolCallId,
				{ command: params.command, timeout: timeoutSeconds },
				signal,
				onUpdate,
				ctx,
			);
			const noted = withNotes(result, { task, mode: ctx.mode, interrupted, ready: readiness });
			// A server that exited before it was ready failed at what it was started for.
			return readiness?.outcome.kind === "exited" ? { ...noted, isError: true } : noted;
		},
	});

	pi.registerMessageRenderer<TaskDetails | BatchDetails>(
		MESSAGE_TYPE,
		(message, { expanded, outputPad }, theme) => {
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			const [first = "", ...rest] = text.split("\n");
			const head = theme.fg(message.details?.failed ? "error" : "success", first);
			const box = new Box(outputPad, 1, (line) => theme.bg("customMessageBg", line));
			box.addChild(
				new Text(
					expanded ? [head, ...rest.map((line) => theme.fg("toolOutput", line))].join("\n") : head,
					0,
					0,
				),
			);
			return box;
		},
	);

	pi.registerCommand("tasks", {
		description:
			"Manage background tasks: pick one to see its output or stop it; /tasks stop <id> stops one",
		handler: async (args, ctx) => {
			const current = attach(ctx);
			const all = [...current.table.tasks.values()].reverse();
			// BB runs Pi over RPC and drops notifications, so outside the TUI answers go into the transcript.
			const tui = ctx.mode === "tui";
			const answer = (text: string, level: "info" | "warning" = "info") =>
				tui ? ctx.ui.notify(text, level) : showToUser(text);
			const stopTask = (task: Task) =>
				task.running
					? userStop(task, tui)
					: answer(`Task ${task.id} already ${endSummary(task)}.`, "warning");
			const showOutput = async (task: Task) => {
				const output = cleanOutput(task.tail(64 * 1024), 500) || "(no output yet)";
				await ctx.ui.editor(
					`Task ${task.id} · ${status(task)} · ${title(task, 60)} · ${task.logPath}`,
					`$ ${task.label}\n\n${output}\n`,
				);
			};

			const [verb, target] = args.trim().split(/\s+/);
			if (verb) {
				const task = current.table.get(taskId(target ?? verb) ?? 0);
				if (!task) return answer(`No background task ${target ?? verb}.`, "warning");
				if (verb === "stop" || verb === "kill") return stopTask(task);
				return showOutput(task);
			}
			if (all.length === 0 || !ctx.hasUI) return answer(listTasks(all));

			const now = Date.now();
			const labels = all.map(
				(task) =>
					`${task.id}  ${status(task)}  ${formatDuration((task.endedAt ?? now) - task.startedAt)}  ${title(task, 60)}`,
			);
			const picked = await ctx.ui.select("Background tasks", labels);
			const task = picked === undefined ? undefined : all[labels.indexOf(picked)];
			if (!task) return;
			const action = await ctx.ui.select(
				`Task ${task.id} ${quote(task.label, 60)}`,
				task.running ? ["Show output", "Stop"] : ["Show output"],
			);
			if (action === "Stop") return stopTask(task);
			if (action === "Show output") return showOutput(task);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		writeState(attach(ctx));
	});

	pi.on("session_shutdown", async (event) => {
		const current = state;
		state = undefined;
		if (!current) return;
		current.watcher?.close();
		hideWidget(current);
		clearTimeout(flushTimer);
		flushTimer = undefined;
		const unsent = pending.splice(0).filter((task) => !task.reported);
		if (event.reason === "reload") {
			// The next runtime binds the same table on its session_start; tasks that end meanwhile are queued,
			// and so are the ones this runtime had not reported yet.
			current.table.bind(undefined);
			current.table.requeue(unsent);
			return;
		}
		tables().delete(current.id);
		await current.table.stopAll();
		current.table.dispose();
	});
}
