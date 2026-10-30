/**
 * Process supervision for bash-jobs: run a shell command, stop waiting for it after a budget while it
 * keeps running, and track it as a background job until its whole process group is gone.
 *
 * Every command runs in its own process group (spawned detached, like Pi's bash tool), so a job is
 * "running" while any process in that group lives, including ones the command started with `&`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";

/** After the shell exits, how long processes it left behind may linger before they count as a background job. */
const LINGER_MS = 500;
/** Once the group is gone, pipes that stay quiet this long count as drained. */
const IDLE_MS = 200;
/** Once the group is gone, stop reading pipes that an escaped process (setsid) keeps writing to after this long. */
const DRAIN_MS = 1000;
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
/** Ended jobs kept for `jobs` and `wait`. */
const KEEP_ENDED = 20;

/** Why a job ended: on its own, its timeout, a stop request, or session shutdown. */
export type JobEnd = "exit" | "timeout" | "stopped" | "shutdown";

/**
 * Why a command moved to the background: it outlived the wait, the model asked for it, or it exited
 * but left processes running in its group.
 */
export type BackgroundReason = "waited" | "requested" | "leftover";

export interface JobSpec {
	/** Text passed to the shell (may include Pi's command prefix). */
	command: string;
	/** The command as the model wrote it, used in messages and for duplicate checks. */
	label: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: string;
	args: string[];
	/** The shell reads the command from stdin instead of argv. */
	commandFromStdin?: boolean;
	/** Kill the command this many seconds after it started. */
	timeoutSeconds?: number;
}

export function groupAlive(pgid: number | undefined): boolean {
	if (!pgid) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), ms);
		void promise.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

export class Job {
	/** Job number (`%N`), assigned when the job moves to the background; 0 while in the foreground. */
	id = 0;
	readonly label: string;
	readonly cwd: string;
	readonly pid: number | undefined;
	readonly startedAt = Date.now();
	readonly timeoutSeconds: number | undefined;
	logPath: string;
	reason: BackgroundReason | undefined;
	backgroundedAt: number | undefined;
	endedAt: number | undefined;
	shellExitedAt: number | undefined;
	exitCode: number | null = null;
	exitSignal: NodeJS.Signals | null = null;
	end: JobEnd | undefined;
	spawnError: Error | undefined;
	/** The model already has this job's final result, so it gets no message when the job ends. */
	reported = false;
	/** Tool calls waiting on this job. A job that ends while watched counts as reported. */
	watchers = 0;
	readonly ended: Promise<void>;

	/** Receives output while a tool call waits in the foreground. */
	sink: ((chunk: Buffer) => void) | undefined;
	/** Foreground hooks, cleared when the job moves to the background. */
	onLinger: (() => void) | undefined;
	onDeadline: (() => void) | undefined;
	/** Set by the table. */
	onEnd: ((job: Job) => void) | undefined;

	private readonly child: ChildProcess;
	private fd: number | undefined;
	private logBytes = 0;
	private openStreams = 2;
	private lastDataAt = Date.now();
	private groupGoneAt: number | undefined;
	private lingered = false;
	private timer: NodeJS.Timeout | undefined;
	private deadline: NodeJS.Timeout | undefined;
	private resolveEnded!: () => void;

	constructor(spec: JobSpec, logPath: string) {
		this.label = spec.label;
		this.cwd = spec.cwd;
		this.logPath = logPath;
		this.timeoutSeconds = spec.timeoutSeconds;
		this.ended = new Promise((resolve) => {
			this.resolveEnded = resolve;
		});
		this.fd = openSync(logPath, "a", 0o600);
		try {
			this.child = spawn(spec.shell, spec.commandFromStdin ? spec.args : [...spec.args, spec.command], {
				cwd: spec.cwd,
				env: spec.env,
				detached: true,
				stdio: [spec.commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			});
		} catch (error) {
			this.discardLog();
			throw error;
		}
		this.pid = this.child.pid;
		if (spec.commandFromStdin) {
			this.child.stdin?.on("error", () => {});
			this.child.stdin?.end(spec.command);
		}
		for (const stream of [this.child.stdout, this.child.stderr]) {
			stream?.on("data", (chunk: Buffer) => this.write(chunk));
			stream?.once("close", () => {
				this.openStreams--;
				this.check();
			});
		}
		this.child.once("error", (error) => {
			this.spawnError ??= error;
			this.finish();
		});
		this.child.once("exit", (code, signal) => {
			this.exitCode = code;
			this.exitSignal = signal;
			this.shellExitedAt = Date.now();
			this.check();
		});
		if (spec.timeoutSeconds !== undefined) {
			this.deadline = setTimeout(
				() => (this.onDeadline ? this.onDeadline() : void this.stop("timeout")),
				Math.min(spec.timeoutSeconds * 1000, MAX_TIMER_MS),
			);
		}
	}

	get running(): boolean {
		return this.endedAt === undefined;
	}

	/** Exit status in shell terms: the shell's code, or 128 + signal number. */
	exitStatus(): number {
		if (this.exitCode !== null) return this.exitCode;
		if (this.exitSignal) return 128 + (osConstants.signals[this.exitSignal] ?? 0);
		return 1;
	}

	signal(signal: NodeJS.Signals): void {
		if (!this.pid) return;
		try {
			process.kill(-this.pid, signal);
		} catch {
			// The group is already gone.
		}
	}

	/** Signal the process group and wait for it to end, escalating to SIGKILL after the grace period. */
	async stop(end: JobEnd, signal: NodeJS.Signals = "SIGTERM", graceMs = 2000): Promise<void> {
		if (!this.running) return;
		this.end ??= end;
		this.signal(signal);
		if (signal !== "SIGKILL" && !(await settlesWithin(this.ended, graceMs))) this.signal("SIGKILL");
		// A process that escaped the group can keep the pipes open; stop tracking after one more second.
		if (!(await settlesWithin(this.ended, 1000))) this.finish();
	}

	/** The last `maxBytes` of the log, starting at a line boundary. */
	tail(maxBytes = 8192): string {
		let fd: number | undefined;
		try {
			fd = openSync(this.logPath, "r");
			const size = fstatSync(fd).size;
			const start = Math.max(0, size - maxBytes);
			const buffer = Buffer.alloc(size - start);
			readSync(fd, buffer, 0, buffer.length, start);
			const text = buffer.toString("utf8");
			return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
		} catch {
			return "";
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	moveLog(path: string): void {
		try {
			renameSync(this.logPath, path);
			this.logPath = path;
		} catch {
			// Keep the old name.
		}
	}

	discardLog(): void {
		this.closeLog();
		try {
			unlinkSync(this.logPath);
		} catch {
			// Already gone.
		}
	}

	private write(chunk: Buffer): void {
		this.lastDataAt = Date.now();
		this.sink?.(chunk);
		if (this.fd === undefined) return;
		try {
			if (this.logBytes + chunk.length > MAX_LOG_BYTES) {
				writeSync(this.fd, `\n[log stopped at ${MAX_LOG_BYTES / 1024 / 1024} MB; later output is discarded]\n`);
				this.closeLog();
				return;
			}
			writeSync(this.fd, chunk);
			this.logBytes += chunk.length;
		} catch {
			this.closeLog();
		}
	}

	private closeLog(): void {
		if (this.fd === undefined) return;
		try {
			closeSync(this.fd);
		} catch {
			// Nothing to do.
		}
		this.fd = undefined;
	}

	/** Called whenever the shell exits or a pipe closes, then polled until the job has ended. */
	private check = (): void => {
		clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.running || this.shellExitedAt === undefined) return;
		const now = Date.now();
		if (groupAlive(this.pid)) {
			this.groupGoneAt = undefined;
			if (!this.lingered && now - this.shellExitedAt >= LINGER_MS) {
				this.lingered = true;
				this.onLinger?.();
			}
		} else {
			this.groupGoneAt ??= now;
			const quiet = now - Math.max(this.lastDataAt, this.shellExitedAt) >= IDLE_MS;
			if (this.openStreams === 0 || quiet || now - this.groupGoneAt >= DRAIN_MS) {
				this.finish();
				return;
			}
		}
		this.timer = setTimeout(this.check, now - this.shellExitedAt < 2000 ? 50 : 1000);
	};

	private finish(): void {
		if (!this.running) return;
		this.endedAt = Date.now();
		clearTimeout(this.timer);
		clearTimeout(this.deadline);
		this.child.stdout?.destroy();
		this.child.stderr?.destroy();
		this.closeLog();
		this.end ??= "exit";
		if (this.watchers > 0) this.reported = true;
		this.resolveEnded();
		this.onEnd?.(this);
	}
}

export interface JobEvents {
	/** A background job ended for any reason other than session shutdown. */
	ended(job: Job): void;
	/** A job moved to the background or a background job ended. */
	changed(): void;
}

/**
 * Remove job directories (`<name>-<pid>`) of Pi processes that are gone without cleaning up, for
 * example after `kill -9`. A directory whose process still runs, or might, is left alone.
 */
export function removeStaleTables(root: string): void {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		const pid = Number(/-(\d+)$/.exec(name)?.[1]);
		if (!pid || pid === process.pid) continue;
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(join(root, name), { recursive: true, force: true });
		}
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell functions that make `%N` in `jobs`, `wait` and `kill` reach the background jobs of earlier
 * calls, anywhere in a command. A command that starts its own jobs (`cmd & wait %1`, so `$!` is set)
 * keeps bash's meaning of `%N`; asking `jobs` instead would make bash forget jobs that just ended.
 * The extension keeps `job-N.pgid` while a job runs and writes `job-N.status` when it ends.
 * `job-N.waiting` holds the pid of a shell waiting for the job, and `job-N.watched` says that shell
 * read the result (or killed the job), so the extension sends no message about the end.
 */
function jobControlScript(dir: string): string {
	return `# bash-jobs: %N in jobs, wait and kill refers to background jobs of earlier bash calls.
# Written to survive the caller's set -eu: every step that can fail is a condition.
__pi_jobs=${shellQuote(dir)}
__pi_job() {
	[ -z "\${!:-}" ] && { [ -e "$__pi_jobs/job-\${1#%}.pgid" ] || [ -e "$__pi_jobs/job-\${1#%}.status" ]; }
}
jobs() {
	command jobs "$@"
	if [ -s "$__pi_jobs/jobs" ]; then cat "$__pi_jobs/jobs"; fi
	return 0
}
wait() {
	if [ $# -eq 0 ]; then command wait; return; fi
	for __pi_a in "$@"; do
		case $__pi_a in
		%[0-9]*) if ! __pi_job "$__pi_a"; then command wait "$@"; return; fi ;;
		*) command wait "$@"; return ;;
		esac
	done
	__pi_s=0
	for __pi_a in "$@"; do
		{ printf '%s\n' "$$" >> "$__pi_jobs/job-\${__pi_a#%}.waiting"; } 2>/dev/null || :
		while [ ! -e "$__pi_jobs/job-\${__pi_a#%}.status" ]; do sleep 0.2; done
		__pi_s=$(cat "$__pi_jobs/job-\${__pi_a#%}.status" 2>/dev/null) || __pi_s=1
		{ : > "$__pi_jobs/job-\${__pi_a#%}.watched"; } 2>/dev/null || :
	done
	return "$__pi_s"
}
kill() {
	__pi_first=\${1-} __pi_n=$# __pi_t= __pi_ids= __pi_zero=
	__pi_sig=$__pi_first
	case $__pi_sig in -s|-n) __pi_sig=\${2-} ;; esac
	case $__pi_sig in -0|0) __pi_zero=1 ;; esac
	while [ "$__pi_n" -gt 0 ]; do
		__pi_a=$1
		shift
		__pi_n=$((__pi_n - 1))
		case $__pi_a in
		%[0-9]*) if __pi_job "$__pi_a" && __pi_g=$(cat "$__pi_jobs/job-\${__pi_a#%}.pgid" 2>/dev/null); then
			__pi_ids="$__pi_ids \${__pi_a#%}" __pi_a=-$__pi_g __pi_t=1
		fi ;;
		esac
		set -- "$@" "$__pi_a"
	done
	if [ -n "$__pi_t" ]; then
		case $__pi_first in -*) ;; *) set -- -s TERM "$@" ;; esac
	fi
	# Only a signal that was sent means the command has the result: kill -0 only asks.
	if command kill "$@"; then
		if [ -z "$__pi_zero" ]; then
			for __pi_i in $__pi_ids; do { : > "$__pi_jobs/job-$__pi_i.watched"; } 2>/dev/null || :; done
		fi
		return 0
	fi
	return 1
}
`;
}

/** All commands of one session: the ones still running in the foreground and the background jobs. */
export class JobTable {
	nextId = 1;
	readonly dir: string;
	readonly jobs = new Map<number, Job>();
	private readonly live = new Set<Job>();
	private seq = 0;
	private events: JobEvents | undefined;
	private queued: Job[] = [];

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(this.controlScript, jobControlScript(dir), { mode: 0o600 });
		process.on("exit", this.onProcessExit);
	}

	/** Source this before a command so `jobs`, `wait %N` and `kill %N` reach background jobs. */
	get controlScript(): string {
		return join(this.dir, "jobctl.sh");
	}

	/** `command` with the job-control functions defined first, on the same line so line numbers stay put. */
	withJobControl(command: string): string {
		return `. ${shellQuote(this.controlScript)}; ${command}`;
	}

	/** Deliver events to a new runtime, including any job that ended while none was bound (during a reload). */
	bind(events: JobEvents | undefined): void {
		this.events = events;
		if (!events) return;
		for (const job of this.queued.splice(0)) events.ended(job);
		events.changed();
	}

	start(spec: JobSpec): Job {
		const job = new Job(spec, join(this.dir, `run-${++this.seq}.log`));
		this.live.add(job);
		job.onEnd = (ended) => {
			this.live.delete(ended);
			if (!ended.id) return;
			// Status first, so a shell waiting on the job sees it before the pgid it could signal is gone.
			this.writeState(`job-${ended.id}.status`, `${ended.exitStatus()}\n`);
			rmSync(join(this.dir, `job-${ended.id}.pgid`), { force: true });
			if (this.consumed(ended.id)) ended.reported = true;
			this.writeJobList();
			if (ended.end !== "shutdown") {
				if (this.events) this.events.ended(ended);
				else this.queued.push(ended);
			}
			this.events?.changed();
		};
		return job;
	}

	/**
	 * Whether a command already has this job's result, so its end needs no message. The shell functions in
	 * the control script say so twice: `job-N.waiting` holds the pid of a shell waiting for the job, and
	 * `job-N.watched` is created once that shell read the status (or the kill it sent went out). A wait
	 * whose shell was killed (Esc, a stopped turn) leaves only a dead pid, so the message is still sent.
	 */
	private consumed(id: number): boolean {
		const watched = join(this.dir, `job-${id}.watched`);
		let waiting = "";
		try {
			waiting = readFileSync(join(this.dir, `job-${id}.waiting`), "utf8");
		} catch {
			// Nothing waited in the shell for this job.
		}
		const took = existsSync(watched);
		rmSync(watched, { force: true });
		rmSync(join(this.dir, `job-${id}.waiting`), { force: true });
		return took || waiting.split("\n").some((line) => processAlive(Number(line)));
	}

	background(job: Job, reason: BackgroundReason): void {
		job.id = this.nextId++;
		job.reason = reason;
		job.backgroundedAt = Date.now();
		job.sink = undefined;
		job.onLinger = undefined;
		job.onDeadline = undefined;
		job.moveLog(join(dirname(job.logPath), `job-${job.id}.log`));
		this.jobs.set(job.id, job);
		if (job.pid) this.writeState(`job-${job.id}.pgid`, `${job.pid}\n`);
		this.writeJobList();
		const ended = [...this.jobs.values()].filter((other) => !other.running);
		for (const old of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) this.jobs.delete(old.id);
		this.events?.changed();
	}

	get(id: number): Job | undefined {
		return this.jobs.get(id);
	}

	running(): Job[] {
		return [...this.jobs.values()].filter((job) => job.running);
	}

	findRunning(label: string, cwd: string): Job | undefined {
		return this.running().find((job) => job.label === label && job.cwd === cwd);
	}

	/** Stop every command, foreground or background, without reporting them as ended. */
	async stopAll(): Promise<void> {
		await Promise.all([...this.live].map((job) => job.stop("shutdown", "SIGTERM", 1000)));
	}

	dispose(): void {
		process.off("exit", this.onProcessExit);
		rmSync(this.dir, { recursive: true, force: true });
	}

	private writeState(name: string, content: string): void {
		try {
			writeFileSync(join(this.dir, name), content, { mode: 0o600 });
		} catch {
			// The directory is gone (session ended); nothing reads it any more.
		}
	}

	/** What `jobs` prints from inside a command: the running background jobs. */
	private writeJobList(): void {
		const lines = this.running().map((job) => `[%${job.id}]  Running  ${job.label.replace(/\s*\n\s*/g, " ")}  (pid ${job.pid})`);
		this.writeState("jobs", lines.length ? `${lines.join("\n")}\n` : "");
	}

	/** Pi is exiting without a session shutdown (killed by a signal, or BB stopped it): leave nothing behind. */
	private onProcessExit = (): void => {
		for (const job of this.live) job.signal("SIGKILL");
		rmSync(this.dir, { recursive: true, force: true });
	};
}

export interface RunOptions extends JobSpec {
	/** How long to wait for the command before it moves to the background. */
	waitMs: number;
	/** Recorded on the job when it moves to the background after `waitMs`. */
	reason: "waited" | "requested";
	signal?: AbortSignal;
	onData(chunk: Buffer): void;
}

export type RunResult = { kind: "exited"; exitCode: number } | { kind: "background"; job: Job };

/**
 * Run a command and wait for it in the foreground for at most `waitMs`. A command still running then,
 * or one that exited but left processes in its group, keeps running as a background job.
 * Abort and the timeout kill it while it is in the foreground and reject like Pi's bash operations
 * (`aborted`, `timeout:<seconds>`); after that the timeout stops the background job.
 */
export function runCommand(table: JobTable, options: RunOptions): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		let job: Job;
		try {
			job = table.start(options);
		} catch (error) {
			reject(error);
			return;
		}
		let waiting = true;
		const release = () => {
			waiting = false;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			job.sink = undefined;
			job.onLinger = undefined;
			job.onDeadline = undefined;
		};
		const toBackground = (reason: BackgroundReason) => {
			if (!waiting) return;
			release();
			table.background(job, reason);
			resolve({ kind: "background", job });
		};
		const kill = (end: JobEnd, error: Error) => {
			if (!waiting) return;
			release();
			void job.stop(end, "SIGKILL").then(() => {
				job.discardLog();
				reject(error);
			});
		};
		const onAbort = () => kill("stopped", new Error("aborted"));
		job.sink = options.onData;
		job.onLinger = () => toBackground("leftover");
		job.onDeadline = () => kill("timeout", new Error(`timeout:${options.timeoutSeconds}`));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => toBackground(options.reason), options.waitMs);
		void job.ended.then(() => {
			if (!waiting) return;
			release();
			job.discardLog();
			if (job.spawnError) reject(job.spawnError);
			else resolve({ kind: "exited", exitCode: job.exitStatus() });
		});
	});
}
