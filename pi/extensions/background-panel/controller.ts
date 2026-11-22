/**
 * Owns the background panel's lifecycle and everything that touches Pi: it listens for
 * `background-jobs:v1:snapshot` messages, answers the capability probe, sends action requests with
 * a timeout, opens the panel and the output view through `ctx.ui.custom`, hides the widgets the
 * panel replaces, and publishes the count line through `ctx.ui.setStatus("background-jobs", …)`
 * (zentui-status-bridge can move it into the zentui editor border as `$jobs`). Rendering lives in
 * panel.ts/output-view.ts; data in registry.ts/protocol.ts; the JSON file it reads is documented
 * in config.ts. Outside a TUI session it installs none of this: no key handler, no widget, no
 * status, nothing republished.
 */
import { getMarkdownTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import {
	backgroundJobsActionReply,
	backgroundJobsMessage,
	type BackgroundJobActionName,
	type BackgroundJobOutput,
	type BackgroundJobsActionReply,
	BACKGROUND_JOBS_ACTION_EVENT,
	BACKGROUND_JOBS_ACTION_REPLY_EVENT,
	BACKGROUND_JOBS_CAPABILITY_EVENT,
	BACKGROUND_JOBS_PROTOCOL_VERSION,
	BACKGROUND_JOBS_SNAPSHOT_EVENT,
} from "./protocol.ts";
import type { BackgroundPanelOpenKey } from "./config.ts";
import { OutputView } from "./output-view.ts";
import { Panel, type PanelResult, type PanelState, type PanelTheme } from "./panel.ts";
import { backgroundJobsSummary, type BackgroundJobsRegistry, type TabJob } from "./registry.ts";

/** The status key that carries the count line; zentui-status-bridge can pick it up as `$jobs`. */
export const BACKGROUND_PANEL_STATUS_KEY = "background-jobs";
/** Widgets the panel replaces while active: pi-interactive-shell's list of background sessions. */
const REPLACED_WIDGETS = ["bg-sessions"];
const WIDGET_KEY = "background-panel";
/** How long the panel waits for an action reply before showing an error. */
export const BACKGROUND_JOBS_ACTION_TIMEOUT_MS = 3000;

/** The config fields the controller reads (config.ts resolves and validates them). */
export interface BackgroundPanelRuntimeConfig {
	openKey: BackgroundPanelOpenKey;
	tabOrder: Record<string, number>;
	hideNativeWidgets: boolean;
}

/** pi-tui's focus is private; an editor is the focused component that has getText and setText. */
interface FocusableTui {
	focusedComponent?: unknown;
	requestRender(): void;
	terminal?: { rows?: number };
}

function isTuiContext(ctx: ExtensionContext): boolean {
	try {
		const mode = (ctx as ExtensionContext & { mode?: string }).mode;
		return ctx.hasUI && (mode === undefined || mode === "tui");
	} catch {
		return false;
	}
}

function markdownTheme(): MarkdownTheme | undefined {
	// Pi's markdown theme, as assistant messages use it; none (plain text) if the theme is not ready.
	try {
		return getMarkdownTheme();
	} catch {
		return undefined;
	}
}

export class BackgroundPanelController {
	private readonly registry: BackgroundJobsRegistry;
	private readonly events: EventBus | undefined;
	private readonly getConfig: () => BackgroundPanelRuntimeConfig;
	private ctx: ExtensionContext | undefined;
	private tui: FocusableTui | undefined;
	private offInput: (() => void) | undefined;
	private installed = false;
	private readonly panelState: PanelState = { showInactive: false };
	private open = false;
	private announced = false;
	private summary: string | undefined;
	private statusShown: string | undefined;
	private nextRequestId = 0;
	private readonly pending = new Map<
		string,
		{ timer: ReturnType<typeof setTimeout>; resolve: (reply: BackgroundJobsActionReply) => void }
	>();

	constructor(
		events: EventBus | undefined,
		registry: BackgroundJobsRegistry,
		getConfig: () => BackgroundPanelRuntimeConfig,
	) {
		this.events = events;
		this.registry = registry;
		this.getConfig = getConfig;
		this.registry.onChange(() => this.registryChanged());
		if (!events) return;
		events.on(BACKGROUND_JOBS_CAPABILITY_EVENT, (value) => this.answerCapability(value));
		events.on(BACKGROUND_JOBS_SNAPSHOT_EVENT, (value) => this.acceptSnapshot(value));
		events.on(BACKGROUND_JOBS_ACTION_REPLY_EVENT, (value) => this.receiveReply(value));
	}

	/** The context of the current TUI session, for callers that need it (the attach wiring). */
	currentContext(): ExtensionContext | undefined {
		return this.ctx;
	}

	/** A new session: drop the old wiring and data, then install in a TUI session. */
	startSession(ctx: ExtensionContext): void {
		this.uninstall();
		this.ctx = isTuiContext(ctx) ? ctx : undefined;
		this.announced = false;
		this.registry.clear();
		if (!this.ctx) return;
		this.install(this.ctx);
	}

	/** Whether the panel is live in the current session; the bridges ask before polling. */
	isComponentActive(): boolean {
		return this.ctx !== undefined;
	}

	/** Session shutdown or reload: leave every touched Pi surface as it was. */
	shutdown(): void {
		this.uninstall();
		this.registry.clear();
		const ctx = this.ctx;
		this.ctx = undefined;
		for (const request of this.pending.values()) clearTimeout(request.timer);
		this.pending.clear();
		this.open = false;
		this.announced = false;
		this.summary = undefined;
		if (this.statusShown !== undefined) {
			this.statusShown = undefined;
			if (ctx) {
				try {
					ctx.ui.setStatus(BACKGROUND_PANEL_STATUS_KEY, undefined);
				} catch {
					// The context can be stale while the session is replaced.
				}
			}
		}
	}

	/** pi-interactive-shell can reinstall its widget any time; hide it again on the next agent run. */
	suppressReplacedWidgets(ctx?: ExtensionContext): void {
		const current = ctx ?? this.ctx;
		if (!current || !this.getConfig().hideNativeWidgets) return;
		for (const key of REPLACED_WIDGETS) {
			try {
				current.ui.setWidget(key, undefined);
			} catch {
				// The context can be stale while the session is replaced.
			}
		}
	}

	private install(ctx: ExtensionContext): void {
		this.installed = true;
		this.offInput = ctx.ui.onTerminalInput((data) => this.handleKey(data));
		try {
			// An empty widget, only to learn the TUI: the open key must not open the panel while a
			// dialog has focus.
			ctx.ui.setWidget(WIDGET_KEY, (tui) => {
				// SAFETY: pi-tui's focus is private; only the public members the panel reads are used.
				this.tui = tui as unknown as FocusableTui;
				return { render: () => [], invalidate: () => {} };
			});
		} catch {
			// A host without widget factories keeps the focus check permissive.
		}
		this.suppressReplacedWidgets();
		// A provider's session_start may run after this one and reinstall its widget.
		const timer = setTimeout(() => {
			if (this.ctx === ctx) this.suppressReplacedWidgets();
		}, 0);
		timer.unref?.();
		this.announceCapability();
		this.registryChanged();
	}

	private uninstall(): void {
		if (!this.installed) return;
		this.installed = false;
		this.offInput?.();
		this.offInput = undefined;
		const ctx = this.ctx;
		if (ctx) {
			try {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
			} catch {
				// The context can be stale while the session is replaced.
			}
		}
		this.tui = undefined;
	}

	private answerCapability(value: unknown): void {
		if (value === null || typeof value !== "object" || Array.isArray(value)) return;
		try {
			// Define data properties rather than invoking publisher setters.
			Object.defineProperties(value, {
				supported: { value: true, writable: true, enumerable: true, configurable: true },
				active: {
					value: this.isComponentActive(),
					writable: true,
					enumerable: true,
					configurable: true,
				},
				version: {
					value: BACKGROUND_JOBS_PROTOCOL_VERSION,
					writable: true,
					enumerable: true,
					configurable: true,
				},
			});
		} catch {
			// Malformed or immutable probes must not break the publisher's event dispatch.
		}
	}

	/** Announces on the capability channel when a session starts, so providers republish. */
	private announceCapability(): void {
		this.announced = this.isComponentActive();
		if (!this.events || !this.announced) return;
		this.events.emit(BACKGROUND_JOBS_CAPABILITY_EVENT, {
			supported: true,
			active: true,
			version: BACKGROUND_JOBS_PROTOCOL_VERSION,
		});
	}

	private acceptSnapshot(value: unknown): void {
		const message = backgroundJobsMessage(value);
		// Snapshots outside a TUI session are ignored, not retained: providers republish when the
		// capability announcement says the panel is active again.
		if (!message || !this.isComponentActive()) return;
		if ("remove" in message) this.registry.remove(message.source);
		else if (message.jobs.length === 0) this.registry.remove(message.source);
		else this.registry.update(message.source, message.tab, message.jobs);
	}

	private registryChanged(): void {
		this.summary = backgroundJobsSummary(this.registry.tabs(this.getConfig().tabOrder));
		this.syncStatus();
	}

	/** The count line as the `background-jobs` status: `↓ 1 workflow · 3 subagents · 1 shell`. */
	private syncStatus(): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const next = this.isComponentActive() ? this.summary : undefined;
		if (next === this.statusShown) return;
		this.statusShown = next;
		try {
			ctx.ui.setStatus(BACKGROUND_PANEL_STATUS_KEY, next);
		} catch {
			// The context can be stale while the session is replaced.
		}
	}

	private handleKey(data: string): { consume: true } | undefined {
		if (this.open || !this.isComponentActive()) return undefined;
		if (isKeyRelease(data) || !matchesKey(data, this.getConfig().openKey)) return undefined;
		const ctx = this.ctx;
		if (!ctx || ctx.ui.getEditorText() !== "" || !this.editorHasFocus()) return undefined;
		if (!this.registry.hasJobs()) return undefined;
		void this.openPanel(ctx);
		return { consume: true };
	}

	private editorHasFocus(): boolean {
		const focused = this.tui?.focusedComponent as Record<string, unknown> | undefined;
		if (!focused || typeof focused !== "object") return true;
		return typeof focused.getText === "function" && typeof focused.setText === "function";
	}

	private async openPanel(ctx: ExtensionContext): Promise<void> {
		this.open = true;
		try {
			for (;;) {
				const result = await ctx.ui.custom<PanelResult>((tui, theme, _keys, done) => {
					// SAFETY: Pi's Theme structurally provides fg/bg/bold with the panel's theme-token names.
					const panelTheme = theme as unknown as PanelTheme;
					const panel = new Panel(
						this.registry,
						() => this.getConfig().tabOrder,
						panelTheme,
						this.panelState,
						{ stop: (job) => this.stopJob(job) },
						done,
						() => tui.requestRender(),
					);
					const off = this.registry.onChange(() => tui.requestRender());
					return {
						render: (width: number) => panel.render(width),
						handleInput: (data: string) => panel.handleInput(data),
						invalidate: () => {},
						dispose: off,
					};
				});
				if (result?.kind === "open") {
					// The editor is back now: the job's own UI (such as an attached terminal) takes over.
					this.open = false;
					const job = result.job;
					const reply = await this.requestAction(job.source, job.id, "open");
					if (!reply.ok)
						ctx.ui.notify(
							`Could not ${job.actions?.open ?? "open"}: ${reply.error ?? "no answer"}`,
							"warning",
						);
					return;
				}
				if (result?.kind !== "output") return;
				const { job, tabId } = result;
				const noun =
					this.registry.tabs(this.getConfig().tabOrder).find((tab) => tab.id === tabId)?.noun[0] ??
					"job";
				const title = `${noun[0].toUpperCase()}${noun.slice(1)} output`;
				await ctx.ui.custom<void>(
					(tui, theme, _keys, done) => {
						// SAFETY: only the terminal size is read; pi-tui keeps rows on its Terminal.
						const terminalRows = ((tui as unknown as FocusableTui).terminal?.rows ?? 30) * 0.85;
						const view = new OutputView(
							title,
							() => this.registry.job(job.key),
							job,
							// SAFETY: Pi's Theme structurally provides fg/bg/bold with the panel's theme-token names.
							theme as unknown as PanelTheme,
							() => Math.floor(terminalRows),
							(current) => this.loadOutput(current),
							() => done(),
							() => tui.requestRender(),
							markdownTheme(),
						);
						return view;
					},
					{ overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
				);
			}
		} catch (error) {
			ctx.ui.notify(
				`Background panel: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			this.open = false;
		}
	}

	private stopJob(job: TabJob): Promise<{ ok: boolean; error?: string }> {
		return this.requestAction(job.source, job.id, "stop").then((reply) =>
			reply.ok ? { ok: true } : { ok: false, error: reply.error ?? "no answer" },
		);
	}

	private async loadOutput(job: TabJob): Promise<BackgroundJobOutput | undefined> {
		const reply = await this.requestAction(job.source, job.id, "output");
		if (!reply.ok) throw new Error(reply.error ?? "no answer");
		return reply.output;
	}

	private requestAction(
		source: string,
		jobId: string,
		action: BackgroundJobActionName,
	): Promise<BackgroundJobsActionReply> {
		return new Promise((resolve) => {
			if (!this.events) {
				resolve({ requestId: "", ok: false, error: "the Pi event bus is unavailable" });
				return;
			}
			const requestId = `background-jobs-${process.pid}-${++this.nextRequestId}`;
			let settled = false;
			const finish = (reply: BackgroundJobsActionReply): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.pending.delete(requestId);
				resolve(reply);
			};
			const timer = setTimeout(() => {
				finish({ requestId, ok: false, error: "the source did not answer in time" });
			}, BACKGROUND_JOBS_ACTION_TIMEOUT_MS);
			timer.unref?.();
			this.pending.set(requestId, { timer, resolve: finish });
			this.events.emit(BACKGROUND_JOBS_ACTION_EVENT, {
				version: BACKGROUND_JOBS_PROTOCOL_VERSION,
				requestId,
				source,
				jobId,
				action,
			});
		});
	}

	private receiveReply(value: unknown): void {
		const reply = backgroundJobsActionReply(value);
		if (!reply) return;
		const request = this.pending.get(reply.requestId);
		if (!request) return;
		this.pending.delete(reply.requestId);
		clearTimeout(request.timer);
		request.resolve(reply);
	}
}
