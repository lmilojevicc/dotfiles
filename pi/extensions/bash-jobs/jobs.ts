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
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	unlinkSync,
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
	/** The command as the model wrote it, used in messages. */
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
	/** Log offset up to which the model has read the output (`jobs output`). */
	readOffset = 0;
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

	/**
	 * Output written since the last call (the first call returns everything), at most `maxBytes` of it:
	 * when more arrived, the oldest part is skipped and `skipped` says how many bytes.
	 */
	unread(maxBytes = 16 * 1024): { text: string; skipped: number } {
		let fd: number | undefined;
		try {
			fd = openSync(this.logPath, "r");
			const size = fstatSync(fd).size;
			const start = Math.max(this.readOffset, size - maxBytes);
			const buffer = Buffer.alloc(Math.max(0, size - start));
			readSync(fd, buffer, 0, buffer.length, start);
			const skipped = start - this.readOffset;
			this.readOffset = size;
			const text = buffer.toString("utf8");
			return { text: skipped > 0 ? text.slice(text.indexOf("\n") + 1) : text, skipped };
		} catch {
			return { text: "", skipped: 0 };
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	markRead(): void {
		this.readOffset = this.logBytes;
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
		process.on("exit", this.onProcessExit);
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
			if (ended.end !== "shutdown") {
				if (this.events) this.events.ended(ended);
				else this.queued.push(ended);
			}
			this.events?.changed();
		};
		return job;
	}

	background(job: Job, reason: BackgroundReason): void {
		job.id = this.nextId++;
		job.reason = reason;
		job.backgroundedAt = Date.now();
		job.sink = undefined;
		job.onLinger = undefined;
		job.onDeadline = undefined;
		job.moveLog(join(dirname(job.logPath), `job-${job.id}.log`));
		// The model saw the output so far in the bash result; `jobs output` starts after it.
		job.markRead();
		this.jobs.set(job.id, job);
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

	/** Stop every command, foreground or background, without reporting them as ended. */
	async stopAll(): Promise<void> {
		await Promise.all([...this.live].map((job) => job.stop("shutdown", "SIGTERM", 1000)));
	}

	dispose(): void {
		process.off("exit", this.onProcessExit);
		rmSync(this.dir, { recursive: true, force: true });
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
