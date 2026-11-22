/**
 * The Terminals tab: a reference provider for pi-interactive-shell's background sessions, built as
 * a bridge (config `bridges.piInteractiveShell` in `background-panel.json`). That package publishes
 * no list over `pi.events`, but keeps its session manager on globalThis (so sessions survive
 * /reload); the bridge looks it up there on each poll and subscribes to its `onChange`. `open`
 * (`attach`) hands the session to the package's own interactive overlay by sending `/attach <id>`
 * once the panel has closed; `output` peeks the session's tail read-only; `stop` (`kill`) kills it.
 * Depends on pi-interactive-shell internals (the globalThis manager key and `/attach`); those can
 * change, and `/attach` changing breaks the attach action.
 */
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { BackgroundJob, BackgroundJobsTab } from "../protocol.ts";
import { boundedOutput, boundedText, BridgePublisher, BRIDGE_POLL_MS } from "./common.ts";

const MANAGER_KEY = "__piInteractiveShellSessionManagerV1";
const TAIL_LINES = 2000;
/** How many tail lines are compared to notice new output without reading the whole tail. */
const QUIET_PROBE_LINES = 40;

/** A running session whose output has not changed for this long is probably waiting for input. */
export const PI_SHELL_QUIET_MS = 5000;

export const PI_INTERACTIVE_SHELL_SOURCE = "pi-interactive-shell";
export const PI_INTERACTIVE_SHELL_TAB: BackgroundJobsTab = {
	id: "terminals",
	label: "Terminals",
	noun: ["terminal", "terminals"],
	order: 30,
};

interface PtySession {
	exited: boolean;
	exitCode?: number | null;
	kill(signal?: string): void;
	getTailLines(options: { lines: number; ansi?: boolean }): { lines: string[] };
}

interface ShellSession {
	id: string;
	command: string;
	reason?: string;
	startedAt: Date;
	session: PtySession;
}

interface SessionManager {
	list(): ShellSession[];
	onChange(listener: () => void): () => void;
}

function manager(): SessionManager | undefined {
	const candidate = (globalThis as Record<string, unknown>)[MANAGER_KEY] as
		| Partial<SessionManager>
		| undefined;
	return typeof candidate?.list === "function" && typeof candidate.onChange === "function"
		? (candidate as SessionManager)
		: undefined;
}

/** The extension's wiring provides this: it sends `/attach <id>` (see index.ts). */
export type AttachSession = (id: string) => void | Promise<void>;

export interface PiInteractiveShellBridgeOptions {
	/** Overrides the poll interval. */
	pollMs?: number;
	/** Runs when the user takes a terminal over (`open`); the wiring sends `/attach <id>`. */
	attach?: AttachSession;
	/** The wall clock, for the quiet badge; tests inject a fake. */
	now?: () => number;
}

/** `quiet 12s`: a running session whose output has not changed for `PI_SHELL_QUIET_MS`. */
function formatQuiet(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

/**
 * Publishes pi-interactive-shell's background sessions while the panel is active; without that
 * package loaded (no manager on globalThis) it publishes nothing, so no empty tab appears. A
 * running session that has printed nothing new for `PI_SHELL_QUIET_MS` gets a `quiet <time>` badge
 * — it often means the program waits for input (a password prompt), which the panel marks with ◆.
 */
export class PiInteractiveShellBridge {
	private readonly publisher: BridgePublisher;
	private readonly pollMs: number;
	private readonly attach: AttachSession | undefined;
	private readonly now: () => number;
	/** When each running session's output tail last changed, to notice a quiet one. */
	private readonly quietSince = new Map<string, { at: number; fingerprint: string }>();
	private active = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private subscribed: SessionManager | undefined;
	private unsubscribe: (() => void) | undefined;

	constructor(events: EventBus | undefined, options: PiInteractiveShellBridgeOptions = {}) {
		this.pollMs = options.pollMs ?? BRIDGE_POLL_MS;
		this.attach = options.attach;
		this.now = options.now ?? (() => Date.now());
		this.publisher = new BridgePublisher(
			events,
			PI_INTERACTIVE_SHELL_SOURCE,
			PI_INTERACTIVE_SHELL_TAB,
		);
		this.publisher.onAction((request) => void this.handleAction(request));
	}

	/** Whether the panel wants this bridge's tab; the extension wiring drives this from its config. */
	setActive(active: boolean): void {
		if (active === this.active) return;
		this.active = active;
		if (active) {
			this.poll();
			this.timer = setInterval(() => this.poll(), this.pollMs);
			this.timer.unref?.();
		} else {
			if (this.timer !== undefined) clearInterval(this.timer);
			this.timer = undefined;
			this.unsubscribe?.();
			this.unsubscribe = undefined;
			this.subscribed = undefined;
			this.publisher.remove();
		}
	}

	/** Rereads the manager and publishes when the sessions changed; also called on its `onChange`. */
	poll(): void {
		if (!this.active) return;
		const current = manager();
		if (current !== this.subscribed) {
			this.unsubscribe?.();
			this.subscribed = current;
			this.unsubscribe = current?.onChange(() => this.poll());
		}
		let sessions: ShellSession[] = [];
		try {
			sessions = current?.list() ?? [];
		} catch {
			sessions = [];
		}
		this.publisher.publish(
			sessions.map((session): BackgroundJob => {
				const running = !session.session.exited;
				return {
					id: session.id,
					title: boundedText(
						[session.command.replace(/\s+/g, " ").trim(), session.reason?.trim()]
							.filter(Boolean)
							.join(" · "),
					),
					status: running ? "running" : (session.session.exitCode ?? 0) === 0 ? "done" : "failed",
					...(running ? { badge: this.quietBadge(session) } : {}),
					startedAt: session.startedAt.getTime(),
					actions: { stop: "kill", open: "attach", output: true },
				};
			}),
		);
	}

	/**
	 * A running session's quiet badge, or undefined while it still prints: the time since its
	 * output tail last changed, once it reaches `PI_SHELL_QUIET_MS`.
	 */
	private quietBadge(session: ShellSession): string | undefined {
		const now = this.now();
		let fingerprint: string;
		try {
			const lines = session.session.getTailLines({ lines: QUIET_PROBE_LINES, ansi: false }).lines;
			fingerprint = `${lines.length}\u0000${lines.slice(-2).join("\n")}`;
		} catch {
			// A session whose tail cannot be read is never called quiet.
			return undefined;
		}
		const previous = this.quietSince.get(session.id);
		const at =
			previous === undefined
				? session.startedAt.getTime()
				: previous.fingerprint === fingerprint
					? previous.at
					: now;
		this.quietSince.set(session.id, { at, fingerprint });
		const quietFor = now - at;
		return quietFor >= PI_SHELL_QUIET_MS ? `quiet ${formatQuiet(quietFor)}` : undefined;
	}

	private sessions(): ShellSession[] {
		try {
			return manager()?.list() ?? [];
		} catch {
			return [];
		}
	}

	private async handleAction(request: {
		requestId: string;
		jobId: string;
		action: "stop" | "open" | "output";
	}): Promise<void> {
		const { requestId, jobId, action } = request;
		const session = this.sessions().find((candidate) => candidate.id === jobId);
		if (!session) {
			this.publisher.replyError(requestId, `no terminal ${jobId}`);
			return;
		}
		if (action === "stop") {
			try {
				session.session.kill();
				this.publisher.reply(requestId, true);
			} catch (error) {
				this.publisher.replyError(
					requestId,
					error instanceof Error ? error.message : "the terminal could not be killed",
				);
			}
			this.poll();
			return;
		}
		if (action === "open") {
			// The panel has already closed; `attach` (index.ts) sends `/attach <id>` to pi-interactive-
			// shell's own interactive overlay, where the user can type into the terminal.
			if (!this.attach) {
				this.publisher.replyError(requestId, "attaching is not wired in this host");
				return;
			}
			try {
				await this.attach(jobId);
				this.publisher.reply(requestId, true);
			} catch (error) {
				this.publisher.replyError(
					requestId,
					error instanceof Error ? error.message : "the terminal could not be attached",
				);
			}
			return;
		}
		this.publisher.reply(requestId, true, {
			output: {
				heading: boundedText(
					`${session.command}  (read-only; Enter in the panel attaches to type into it)`,
				),
				text: boundedOutput(
					session.session.getTailLines({ lines: TAIL_LINES, ansi: false }).lines.join("\n"),
				),
			},
		});
	}
}
