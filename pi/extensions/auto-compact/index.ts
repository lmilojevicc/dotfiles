/**
 * Percentage-based background auto-compaction.
 *
 * Once context usage reaches `thresholdPercent` of the active model's window, the summary is
 * generated in the background while the agent keeps working. When it is ready, it is attached at the
 * next turn boundary as a compaction entry that keeps everything after Pi's usual cut point,
 * including the work done while the summary was being written. Nothing is aborted.
 *
 * Pi's own threshold compaction (window minus `compaction.reserveTokens`) stays as the backstop; if
 * it fires while a background summary is in flight, it reuses that summary instead of starting over.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	compact,
	type CompactionResult,
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getPackageDir,
	type SessionEntry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type LoadedConfig,
	loadConfig,
	resolveConfigPath,
	resolveForModel,
	thresholdTokens,
} from "./config.ts";
import {
	CONTEXT_KEY,
	contextLabel,
	formatCount,
	readZentuiThresholds,
	ZentuiPublisher,
} from "./zentui.ts";

export type Preparation = Parameters<typeof compact>[0];
export type CompactionSettings = Preparation["settings"];
export type PrepareFn = (entries: SessionEntry[], settings: CompactionSettings) => Preparation | undefined;
type Model = NonNullable<ExtensionContext["model"]>;

export interface SummarizeRequest {
	preparation: Preparation;
	model: Model;
	ctx: ExtensionContext;
	signal: AbortSignal;
}

export interface AutoCompactOptions {
	/** Agent dir for Pi's settings and the default config location. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** Overrides `PI_AUTO_COMPACT_CONFIG` and `<agentDir>/auto-compact.json`. */
	configPath?: string;
	/** Pi's internal `prepareCompaction`, which the package does not export. */
	loadPrepare?: () => Promise<PrepareFn>;
	/** Generates the summary. Defaults to Pi's own `compact()` through the model registry. */
	summarize?: (request: SummarizeRequest) => Promise<CompactionResult>;
}

export const STATUS_KEY = "auto-compact";
/**
 * After a failed summary, or a compaction that left usage above the threshold, wait for this much
 * more context (share of the window) before summarizing again, so it never runs on every turn.
 */
const RETRY_GROWTH = 0.05;

interface Job {
	controller: AbortController;
	model: string;
	/** Last branch entry when the summary started; the summary covers nothing after it. */
	leafId: string;
	firstKeptEntryId: string;
	tokensAtStart: number;
	startedAt: number;
	status: "running" | "ready";
	result?: CompactionResult;
	/** Resolves to the result, or undefined when the summary failed or was cancelled. */
	done: Promise<CompactionResult | undefined>;
}

/** Loads `prepareCompaction` from the running Pi install (Node builds ship `dist/`). */
export async function loadPrepareFromPi(): Promise<PrepareFn> {
	const url = pathToFileURL(join(getPackageDir(), "dist/core/compaction/compaction.js")).href;
	const mod = (await import(url)) as { prepareCompaction?: unknown };
	if (typeof mod.prepareCompaction !== "function") {
		throw new Error(`prepareCompaction is not exported by ${url}`);
	}
	return mod.prepareCompaction as PrepareFn;
}

/** Pi's own summary, with request-time auth from the model registry (as `/compact` does). */
export async function summarizeWithPi({ preparation, model, ctx, signal }: SummarizeRequest) {
	const registry = ctx.modelRegistry;
	return compact(
		preparation,
		model,
		undefined,
		undefined,
		undefined,
		signal,
		ctx.thinkingLevel,
		(m, context, options) => registry.streamSimple(m, context as never, options as never),
	);
}

/** True when the job's snapshot is still the start of this branch and nothing compacted since. */
export function stillApplies(
	job: Pick<Job, "leafId" | "firstKeptEntryId">,
	branch: SessionEntry[],
): boolean {
	const leafIndex = branch.findIndex((entry) => entry.id === job.leafId);
	if (leafIndex < 0) return false;
	if (!branch.slice(0, leafIndex + 1).some((entry) => entry.id === job.firstKeptEntryId)) return false;
	return !branch.slice(leafIndex + 1).some((entry) => entry.type === "compaction");
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

function modelKey(model: Model): string {
	return `${model.provider}/${model.id}`;
}

export function createAutoCompact(options: AutoCompactOptions = {}) {
	return function autoCompact(pi: ExtensionAPI): void {
		const agentDir = options.agentDir ?? getAgentDir();
		const configPath = options.configPath ?? resolveConfigPath(agentDir);
		const summarize = options.summarize ?? summarizeWithPi;
		const loadPrepare = options.loadPrepare ?? loadPrepareFromPi;

		let prepare: Promise<PrepareFn> | undefined;
		let job: Job | undefined;
		/** The ready job being applied through ctx.compact() while Pi is idle. */
		let applyingIdle: Job | undefined;
		let lastFailure: { tokens: number; contextWindow: number } | undefined;
		/** Set by a compaction; the first known usage after it becomes the floor. */
		let justCompacted = false;
		let floor: { tokens: number; contextWindow: number } | undefined;
		let lastCtx: ExtensionContext | undefined;
		let lastWarning: string | undefined;
		/** Tokens summarized by the compaction applied during the current interaction. */
		let lastApplied: number | undefined;
		const zentui = new ZentuiPublisher(pi.events);

		function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") {
			// BB drops notify in RPC mode, so a non-TUI host also gets stderr.
			if (ctx.hasUI) ctx.ui.notify(message, level);
			if (level !== "info" && ctx.mode !== "tui") console.error(message);
		}

		function warnOnce(ctx: ExtensionContext, message: string) {
			if (message === lastWarning) return;
			lastWarning = message;
			report(ctx, message, "warning");
		}

		function setStatus(ctx: ExtensionContext | undefined, text: string | undefined) {
			try {
				if (ctx?.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
			} catch {
				// A context from a replaced session can no longer reach the UI.
			}
		}

		function readConfig(ctx: ExtensionContext): LoadedConfig {
			const loaded = loadConfig(configPath);
			if (!loaded.ok) warnOnce(ctx, `Auto-compact disabled (${configPath}): ${loaded.error}`);
			else if (lastWarning?.startsWith("Auto-compact disabled (")) lastWarning = undefined;
			return loaded;
		}

		function piSettings(ctx: ExtensionContext, model: Model): CompactionSettings {
			try {
				return SettingsManager.create(ctx.cwd, agentDir, {
					projectTrusted: ctx.isProjectTrusted(),
				}).getCompactionSettings(model);
			} catch {
				return { ...DEFAULT_COMPACTION_SETTINGS };
			}
		}

		/**
		 * Where compaction actually happens for this model: the auto-compact threshold when it is
		 * enabled, otherwise Pi's own backstop (window − reserveTokens), otherwise the raw window.
		 */
		function compactionLimit(ctx: ExtensionContext, model: Model, contextWindow: number): number {
			const pi = piSettings(ctx, model);
			const backstop = pi.enabled ? contextWindow - pi.reserveTokens : 0;
			let limit = backstop > 0 ? backstop : contextWindow;
			const loaded = loadConfig(configPath);
			if (loaded.ok) {
				const resolved = resolveForModel(loaded.config, model);
				if (resolved.enabled) {
					limit = Math.min(limit, thresholdTokens(contextWindow, resolved.thresholdPercent));
				}
			}
			return limit;
		}

		/** Zentui's border context value and Working-line segment, with Pi's status slot as the fallback. */
		function refreshUi(ctx: ExtensionContext | undefined = lastCtx) {
			if (!ctx) return;
			try {
				// Compaction progress lives on the Working line only; outside a run, or without
				// Zentui's Working line, Pi's status slot shows it instead.
				const segment = job
					? `compacting ${formatCount(job.tokensAtStart)} in background`
					: lastApplied !== undefined
						? `compacted ${formatCount(lastApplied)}`
						: undefined;
				const onWorkingLine = zentui.workingSegment(segment);
				setStatus(ctx, job && !onWorkingLine ? `auto-compact: ${segment}` : undefined);
				const usage = ctx.getContextUsage();
				const model = ctx.model;
				zentui.variable(
					CONTEXT_KEY,
					usage && model
						? contextLabel(
								usage.tokens,
								compactionLimit(ctx, model, usage.contextWindow),
								readZentuiThresholds(agentDir),
							)
						: undefined,
				);
			} catch {
				// A context from a replaced session can no longer be read.
			}
		}

		function cancelJob(ctx?: ExtensionContext) {
			if (!job) return;
			job.controller.abort();
			job = undefined;
			refreshUi(ctx ?? lastCtx);
		}

		/** Hands the ready job over to whoever applies it; a stale job is dropped. */
		function takeReady(branch: SessionEntry[], ctx: ExtensionContext): CompactionResult | undefined {
			const ready = job;
			if (!ready || ready.status !== "ready" || !ready.result) return undefined;
			job = undefined;
			refreshUi(ctx);
			return stillApplies(ready, branch) ? ready.result : undefined;
		}

		/** Reports the context replaced now, the figure Pi's own compaction entry shows. */
		function appliedNotice(ctx: ExtensionContext, result: CompactionResult) {
			let replaced = result.tokensBefore;
			try {
				replaced = ctx.getContextUsage()?.tokens ?? replaced;
			} catch {
				// Keep the snapshot figure.
			}
			lastApplied = replaced;
			refreshUi(ctx);
			report(ctx, `Auto-compacted in the background (${formatTokens(replaced)} tokens replaced)`, "info");
		}

		function isIdle(ctx: ExtensionContext): boolean {
			try {
				return ctx.isIdle();
			} catch {
				return false;
			}
		}

		/** A summary that finished while Pi is idle is applied without waiting for the next prompt. */
		function scheduleIdleApply() {
			setTimeout(() => {
				const ctx = lastCtx;
				const ready = job;
				if (!ctx || !ready || ready.status !== "ready" || applyingIdle || !isIdle(ctx)) return;
				if (!stillApplies(ready, ctx.sessionManager.getBranch())) {
					job = undefined;
					refreshUi(ctx);
					return;
				}
				applyingIdle = ready;
				ctx.compact({
					onComplete: () => {
						if (applyingIdle === ready) applyingIdle = undefined;
					},
					onError: (error) => {
						if (applyingIdle === ready) applyingIdle = undefined;
						if (job === ready) job = undefined;
						refreshUi(ctx);
						report(ctx, `Auto-compact could not apply its summary: ${error.message}`, "warning");
					},
				});
			}, 0);
		}

		/** Starts a background summary when usage crosses the threshold; returns why it did not. */
		async function maybeStart(ctx: ExtensionContext, force = false): Promise<string> {
			if (job) return `a background summary is already ${job.status}`;
			const model = ctx.model;
			if (!model) return "no model is selected";
			const loaded = readConfig(ctx);
			if (!loaded.ok) return `config error: ${loaded.error}`;
			const resolved = resolveForModel(loaded.config, model);
			if (!resolved.enabled && !force) return `disabled for ${modelKey(model)}`;
			const usage = ctx.getContextUsage();
			if (!usage || usage.tokens == null) return "context usage is not known yet";
			const limit = thresholdTokens(usage.contextWindow, resolved.thresholdPercent);
			if (justCompacted) {
				justCompacted = false;
				floor = { tokens: usage.tokens, contextWindow: usage.contextWindow };
				if (usage.tokens >= limit) {
					// System prompt + summary + Pi's keepRecentTokens already exceed the threshold.
					warnOnce(
						ctx,
						`Auto-compact: ${modelKey(model)} is still at ${formatTokens(usage.tokens)} after compacting, above its ${resolved.thresholdPercent}% threshold (${formatTokens(limit)}). Raise thresholdPercent or lower Pi's compaction.keepRecentTokens.`,
					);
				}
			}
			if (!force) {
				if (usage.tokens < limit) return "below the threshold";
				if (
					lastFailure &&
					usage.tokens < lastFailure.tokens + lastFailure.contextWindow * RETRY_GROWTH
				) {
					return "waiting for more context after a failed summary";
				}
				if (floor && usage.tokens < floor.tokens + floor.contextWindow * RETRY_GROWTH) {
					return "waiting for more context after the last compaction";
				}
			}

			prepare ??= loadPrepare();
			let prepareCompaction: PrepareFn;
			try {
				prepareCompaction = await prepare;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				warnOnce(ctx, `Auto-compact disabled: cannot load Pi's compaction internals (${reason})`);
				return "Pi's compaction internals are unavailable";
			}
			if (job) return `a background summary is already ${job.status}`;

			const branch = ctx.sessionManager.getBranch();
			const leaf = branch.at(-1);
			const preparation = leaf ? prepareCompaction(branch, piSettings(ctx, model)) : undefined;
			if (!leaf || !preparation) return "nothing to compact yet";

			const controller = new AbortController();
			const started: Job = {
				controller,
				model: modelKey(model),
				leafId: leaf.id,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensAtStart: usage.tokens,
				startedAt: Date.now(),
				status: "running",
				done: Promise.resolve(undefined),
			};
			started.done = summarize({ preparation, model, ctx, signal: controller.signal }).then(
				(result) => {
					if (job !== started || controller.signal.aborted) return undefined;
					started.status = "ready";
					started.result = result;
					lastFailure = undefined;
					refreshUi();
					scheduleIdleApply();
					return result;
				},
				(error) => {
					if (job !== started || controller.signal.aborted) return undefined;
					job = undefined;
					lastFailure = { tokens: usage.tokens!, contextWindow: usage.contextWindow };
					const reason = error instanceof Error ? error.message : String(error);
					refreshUi();
					if (lastCtx) report(lastCtx, `Auto-compact summary failed: ${reason}`, "warning");
					return undefined;
				},
			);
			job = started;
			refreshUi(ctx);
			return `started at ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`;
		}

		pi.on("session_start", (_event, ctx) => {
			cancelJob(ctx);
			applyingIdle = undefined;
			lastFailure = undefined;
			justCompacted = false;
			floor = undefined;
			lastApplied = undefined;
			lastCtx = ctx;
			refreshUi(ctx);
			// Zentui ignores values published before its first editor render; probe again shortly.
			for (const delay of [150, 600, 2000]) {
				setTimeout(() => {
					if (lastCtx === ctx) refreshUi(ctx);
				}, delay).unref?.();
			}
		});

		pi.on("session_shutdown", () => {
			cancelJob();
			applyingIdle = undefined;
			zentui.clear();
			setStatus(lastCtx, undefined);
		});

		// Keep the border's context value current as usage changes.
		for (const event of ["model_select", "message_end", "tool_execution_end"] as const) {
			pi.on(event, (_event: unknown, ctx: ExtensionContext) => {
				lastCtx = ctx;
				refreshUi(ctx);
			});
		}

		pi.on("turn_end", async (event, ctx) => {
			lastCtx = ctx;
			if (event.outcome === "completed" && !event.entries.some((entry) => entry.type === "compaction")) {
				const result = takeReady(ctx.sessionManager.getBranch(), ctx);
				if (result) {
					appliedNotice(ctx, result);
					justCompacted = true;
					floor = undefined;
					return {
						entries: [
							...event.entries,
							{
								type: "compaction",
								summary: result.summary,
								firstKeptEntryId: result.firstKeptEntryId,
								details: result.details,
								usage: result.usage,
							},
						],
					};
				}
			}
			await maybeStart(ctx);
			refreshUi(ctx);
		});

		pi.on("agent_before_settle", (event, ctx) => {
			lastCtx = ctx;
			if (event.outcome !== "completed" || event.entries.some((entry) => entry.type === "compaction")) return;
			const result = takeReady(ctx.sessionManager.getBranch(), ctx);
			if (!result) return;
			appliedNotice(ctx, result);
			justCompacted = true;
			floor = undefined;
			return {
				entries: [
					...event.entries,
					{
						type: "compaction",
						summary: result.summary,
						firstKeptEntryId: result.firstKeptEntryId,
						details: result.details,
						usage: result.usage,
					},
				],
			};
		});

		pi.on("agent_settled", (_event, ctx) => {
			lastCtx = ctx;
			lastApplied = undefined;
			refreshUi(ctx);
			scheduleIdleApply();
		});

		pi.on("session_before_compact", async (event, ctx) => {
			const current = job;
			if (!current) return;

			if (applyingIdle === current && event.reason === "manual") {
				job = undefined;
				refreshUi(ctx);
				// Never let our idle apply turn into a full compaction nobody asked for.
				if (!current.result || !stillApplies(current, event.branchEntries)) return { cancel: true };
				appliedNotice(ctx, current.result);
				return { compaction: current.result };
			}

			if (event.reason === "threshold" && stillApplies(current, event.branchEntries)) {
				// Pi hit its own limit first: finish the summary already in flight instead of starting over.
				const abort = new Promise<undefined>((resolve) => {
					if (event.signal.aborted) resolve(undefined);
					event.signal.addEventListener("abort", () => resolve(undefined), { once: true });
				});
				const result = current.result ?? (await Promise.race([current.done, abort]));
				if (job === current) job = undefined;
				refreshUi(ctx);
				if (result && stillApplies(current, event.branchEntries)) return { compaction: result };
				return;
			}

			// `/compact` and overflow recovery need Pi's fresh, tighter cut.
			cancelJob(ctx);
		});

		pi.on("session_compact", (_event, ctx) => {
			// Whatever compacted, a remaining background summary now describes replaced context.
			cancelJob(ctx);
			lastFailure = undefined;
			justCompacted = true;
			floor = undefined;
			refreshUi(ctx);
		});

		pi.on("session_compact_failed", () => {
			applyingIdle = undefined;
		});

		pi.registerCommand("auto-compact", {
			description: "Show auto-compact status, or start a background summary now (`/auto-compact now`)",
			handler: async (args, ctx) => {
				lastCtx = ctx;
				if (args.trim() === "now") {
					report(ctx, `Auto-compact: ${await maybeStart(ctx, true)}`, "info");
					return;
				}
				const lines = ["Auto-compact"];
				const loaded = readConfig(ctx);
				lines.push(
					`  config: ${configPath}${loaded.ok ? (loaded.missing ? " (missing, defaults)" : "") : ` (invalid: ${loaded.error})`}`,
				);
				const model = ctx.model;
				const usage = ctx.getContextUsage();
				if (model && loaded.ok) {
					const resolved = resolveForModel(loaded.config, model);
					lines.push(
						`  model: ${modelKey(model)}${resolved.matched ? ` (override: ${resolved.matched})` : ""}`,
						`  threshold: ${resolved.thresholdPercent}%${resolved.enabled ? "" : " (disabled)"}`,
					);
					if (usage) {
						const limit = thresholdTokens(usage.contextWindow, resolved.thresholdPercent);
						const used =
							usage.tokens == null
								? "unknown"
								: `${formatTokens(usage.tokens)} (${Math.round(usage.percent ?? 0)}%)`;
						lines.push(
							`  context: ${used} of ${formatTokens(usage.contextWindow)}; summarizes from ${formatTokens(limit)}`,
						);
						const pi = piSettings(ctx, model);
						if (pi.enabled) {
							const hard = usage.contextWindow - pi.reserveTokens;
							lines.push(
								`  Pi backstop: ${formatTokens(hard)}${limit >= hard ? " — at or below the threshold, so Pi compacts first" : ""}`,
							);
						}
					}
				}
				lines.push(
					`  background summary: ${job ? `${job.status} (started at ${formatTokens(job.tokensAtStart)}, ${Math.round((Date.now() - job.startedAt) / 1000)}s ago)` : "none"}`,
				);
				report(ctx, lines.join("\n"), "info");
			},
		});
	};
}

export default createAutoCompact();
