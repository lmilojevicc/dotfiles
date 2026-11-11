/**
 * Readiness checks for servers started in the background: the call waits until a port accepts
 * connections and/or a log line matches, instead of the model writing its own polling loop.
 */
import { createConnection } from "node:net";
import { cleanOutput } from "./format.ts";
import type { Task } from "./tasks.ts";

/** Default and longest readiness wait, in seconds. */
export const DEFAULT_READY_SECONDS = 30;
export const MAX_READY_SECONDS = 600;
const POLL_MS = 250;
const CONNECT_TIMEOUT_MS = 500;
/** Hosts tried when none is given: dev servers bind `localhost`, which may be either. */
const LOCAL_HOSTS = ["127.0.0.1", "::1"];

export interface ReadySpec {
	port?: number;
	/** Hosts to probe for the port; the first one that accepts wins. */
	hosts: string[];
	log?: RegExp;
	timeoutSeconds: number;
}

export type ReadyOutcome =
	| { kind: "ready" }
	| { kind: "timeout"; portOpen: boolean; logMatched: boolean }
	| { kind: "exited" }
	| { kind: "interrupted" };

/**
 * The readiness condition the model asked for, undefined when it named none, or an error message.
 * Placeholder values (blank strings, port 0), which some tool-call layers send for unset fields,
 * count as unset.
 */
export function parseReady(value: unknown): ReadySpec | string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") {
		if (!value.trim()) return undefined;
		try {
			value = JSON.parse(value);
		} catch {
			return 'ready must be an object such as {"port": 3000} or {"log": "listening on"}';
		}
	}
	if (typeof value !== "object" || Array.isArray(value))
		return 'ready must be an object such as {"port": 3000}';
	const input = value as Record<string, unknown>;
	const blank = (field: unknown) => (typeof field === "string" ? field.trim() || undefined : field);
	const rawPort = blank(input.port);
	const port =
		rawPort === undefined || rawPort === null || Number(rawPort) === 0
			? undefined
			: Number(rawPort);
	if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536))
		return `ready.port must be a TCP port, not ${String(rawPort)}`;
	const host = blank(input.host);
	if (host !== undefined && typeof host !== "string") return "ready.host must be a string";
	const pattern = blank(input.log);
	if (pattern !== undefined && typeof pattern !== "string")
		return "ready.log must be a regular expression as a string";
	let log: RegExp | undefined;
	if (pattern !== undefined) {
		try {
			log = new RegExp(pattern as string);
		} catch (error) {
			return `ready.log is not a valid regular expression: ${(error as Error).message}`;
		}
	}
	if (port === undefined && log === undefined) {
		if (host !== undefined || blank(input.timeout) !== undefined)
			return "ready needs a port or a log pattern";
		return undefined;
	}
	const rawTimeout = blank(input.timeout);
	const timeout =
		rawTimeout === undefined || rawTimeout === null ? DEFAULT_READY_SECONDS : Number(rawTimeout);
	if (!Number.isFinite(timeout) || timeout <= 0)
		return `ready.timeout must be a number of seconds, not ${String(rawTimeout)}`;
	return {
		port,
		hosts: host === undefined ? LOCAL_HOSTS : [host as string],
		log,
		timeoutSeconds: Math.min(timeout, MAX_READY_SECONDS),
	};
}

/** What the readiness condition is, for messages: `port 3000`, `the log matching /ready/`. */
export function describeReady(spec: ReadySpec): string {
	const parts: string[] = [];
	if (spec.port !== undefined)
		parts.push(`port ${spec.port}${spec.hosts === LOCAL_HOSTS ? "" : ` on ${spec.hosts[0]}`}`);
	if (spec.log) parts.push(`the log matching ${spec.log}`);
	return parts.join(" and ");
}

function accepts(host: string, port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		const done = (open: boolean) => {
			socket.destroy();
			resolve(open);
		};
		socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}

async function portOpen(hosts: string[], port: number): Promise<boolean> {
	const results = await Promise.all(hosts.map((host) => accepts(host, port)));
	return results.some(Boolean);
}

/** Scans a task's log from its start for a pattern, a little more on each call. */
class LogScanner {
	private offset = 0;
	private carry = "";
	matched = false;

	private readonly task: Task;
	private readonly pattern: RegExp;

	constructor(task: Task, pattern: RegExp) {
		this.task = task;
		this.pattern = pattern;
	}

	scan(): boolean {
		if (this.matched) return true;
		const { text, end } = this.task.readFrom(this.offset);
		this.offset = end;
		const lines = (this.carry + text).split("\n");
		// A line still being written is tested now and again once it is complete.
		this.carry = (lines.at(-1) ?? "").slice(-64 * 1024);
		this.matched = lines.some((line) => {
			const plain = cleanOutput(line, 1);
			this.pattern.lastIndex = 0;
			return this.pattern.test(plain);
		});
		return this.matched;
	}
}

/**
 * Wait until the task is ready (every given condition holds), exits, the time runs out, or
 * `interrupt` says the user sent a message. Abort rejects like Pi's bash; the task keeps running.
 */
export async function waitReady(
	task: Task,
	spec: ReadySpec,
	options: { signal?: AbortSignal; interrupt?: () => boolean },
): Promise<ReadyOutcome> {
	const deadline = Date.now() + spec.timeoutSeconds * 1000;
	const scanner = spec.log ? new LogScanner(task, spec.log) : undefined;
	let open = false;
	let wake: (() => void) | undefined;
	const onAbort = () => wake?.();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	void task.ended.then(() => wake?.());
	task.watchers++;
	try {
		for (;;) {
			if (options.signal?.aborted) throw new Error("aborted");
			const logMatched = scanner ? scanner.scan() : true;
			open = spec.port === undefined || open || (await portOpen(spec.hosts, spec.port));
			if (open && logMatched) return { kind: "ready" };
			if (!task.running) return { kind: "exited" };
			if (options.interrupt?.()) return { kind: "interrupted" };
			if (Date.now() >= deadline) {
				return {
					kind: "timeout",
					portOpen: spec.port !== undefined && open,
					logMatched: scanner?.matched ?? false,
				};
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, POLL_MS);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			wake = undefined;
		}
	} finally {
		task.watchers--;
		options.signal?.removeEventListener("abort", onAbort);
	}
}
