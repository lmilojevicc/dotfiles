/*
 * Codex quota parsing, bounded fetching and the tab-frame conventions are adapted from the
 * local codex-enhanced extension, itself adapted from @howaboua/pi-codex-conversion 3.0.14:
 * https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/d2e9b82f8abafa24f8488d5211f8307ea4815edb/packages/pi-codex-conversion
 *
 * MIT License — Copyright © 2026 Umberto B.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { homedir } from "node:os";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import {
	formatStatus,
	ProviderStateError,
	statusUsedPercent,
	type AdapterContext,
	type ProviderAdapter,
	type ProviderSnapshot,
} from "./core.ts";
import { PROVIDER_ADAPTERS } from "./providers/index.ts";
import { resetManagementKeyCache } from "./providers/cliproxyapi.ts";
import {
	formatProviderBody,
	formatScrollFrame,
	frameHeight,
	STATUSLINE_RESERVE,
	type FrameBody,
	type TabError,
	type TabState,
} from "./render.ts";

const STATUS_KEY = "usage";
const SNAPSHOT_CACHE_MS = 5 * 60_000;

type CacheEntry = { snapshot?: ProviderSnapshot; expiresAt: number; promise?: Promise<ProviderSnapshot> };

/** Per-provider snapshot cache shared by the footer and the menu; one in-flight fetch per provider. */
const snapshotCache = new Map<string, CacheEntry>();

type UsageDependencies = {
	adapters?: readonly ProviderAdapter[];
	adapterContext?: (ctx: ExtensionContext) => AdapterContext;
};

function createAdapterContext(ctx: ExtensionContext): AdapterContext {
	const registry = ctx.modelRegistry as ExtensionContext["modelRegistry"] & {
		getProviderAuthStatus?: (providerId: string) => { configured?: boolean } | undefined;
	};
	return {
		getProviderAuth: async (providerId) => {
			try {
				const resolved = await registry.getProviderAuth(providerId);
				return resolved?.auth ? { apiKey: resolved.auth.apiKey, baseUrl: resolved.auth.baseUrl } : undefined;
			} catch {
				return undefined;
			}
		},
		hasProviderCredentials: (providerId) => {
			try { return registry.getProviderAuthStatus?.(providerId)?.configured === true; }
			catch { return false; }
		},
		agentDir: getAgentDir(),
		homeDir: homedir(),
		env: process.env,
		fetch: (input, init) => globalThis.fetch(input, init),
	};
}

function errorMessage(error: unknown): TabError {
	if (error instanceof ProviderStateError) return { message: error.message, state: error.state };
	if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return { message: "Request timed out." };
	return { message: error instanceof Error && error.message ? error.message : "Request failed." };
}

/** Fresh cached snapshot unless forced; a failed refresh keeps the previous snapshot cached and rethrows. */
function fetchSnapshot(adapter: ProviderAdapter, adapterContext: AdapterContext, signal: AbortSignal, force = false): Promise<ProviderSnapshot> {
	const cached = snapshotCache.get(adapter.id);
	if (cached?.promise) return cached.promise;
	if (!force && cached?.snapshot && cached.expiresAt > Date.now()) return Promise.resolve(cached.snapshot);
	const entry: CacheEntry = cached ?? { expiresAt: 0 };
	const promise = (async () => {
		try {
			const snapshot = await adapter.fetch(adapterContext, signal);
			entry.snapshot = snapshot;
			entry.expiresAt = Date.now() + SNAPSHOT_CACHE_MS;
			return snapshot;
		} finally {
			entry.promise = undefined;
		}
	})();
	entry.promise = promise;
	snapshotCache.set(adapter.id, entry);
	return promise;
}

async function visibleAdapters(adapters: readonly ProviderAdapter[], adapterContext: AdapterContext): Promise<ProviderAdapter[]> {
	const visible = await Promise.all(adapters.map(async (adapter) => {
		try { return await adapter.hasCredentials(adapterContext); }
		catch { return false; }
	}));
	return adapters.filter((_, index) => visible[index]);
}

/** `<providerId> <used>% used` for the session model's provider, else the first visible provider with data. */
async function computeStatus(ctx: ExtensionContext, adapters: readonly ProviderAdapter[], adapterContext: AdapterContext, signal: AbortSignal): Promise<string | undefined> {
	const visible = await visibleAdapters(adapters, adapterContext);
	const preferred = visible.find((adapter) => adapter.id === ctx.model?.provider);
	for (const adapter of preferred ? [preferred, ...visible.filter((candidate) => candidate !== preferred)] : visible) {
		if (signal.aborted) return undefined;
		let snapshot: ProviderSnapshot | undefined;
		try { snapshot = await fetchSnapshot(adapter, adapterContext, signal); }
		catch { snapshot = snapshotCache.get(adapter.id)?.snapshot; }
		const used = snapshot ? statusUsedPercent(snapshot) : undefined;
		if (used !== undefined) return formatStatus(adapter.id, used);
	}
	return undefined;
}

function setStatus(ctx: ExtensionContext, text?: string): void {
	try {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, text);
	} catch {
		// UI contexts may become stale during reload or shutdown.
	}
}

async function openUsage(ctx: ExtensionContext, shutdownSignal: AbortSignal, dependencies: UsageDependencies = {}): Promise<void> {
	if (ctx.mode !== "tui") {
		const message = "/usage requires interactive terminal mode";
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else throw new Error(message);
		return;
	}
	const adapters = dependencies.adapters ?? PROVIDER_ADAPTERS;
	const adapterContext = (dependencies.adapterContext ?? createAdapterContext)(ctx);
	const viewController = new AbortController();
	const viewSignal = AbortSignal.any([shutdownSignal, viewController.signal]);

	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let tabs: ProviderAdapter[] | undefined;
		let activeTab = 0;
		const states = new Map<string, TabState & { revision: number }>();
		let scrollOffset = 0;
		let bandView = { bandSize: 1, maxOffset: 0 };

		const render = () => {
			if (!viewSignal.aborted) tui.requestRender();
		};
		const scroll = (delta: number) => {
			scrollOffset = Math.max(0, Math.min(scrollOffset + delta, bandView.maxOffset));
			render();
		};
		const scrollTo = (offset: number) => {
			scrollOffset = Math.max(0, Math.min(offset, bandView.maxOffset));
			render();
		};
		const close = () => {
			viewController.abort();
			done(undefined);
		};
		const closeOnShutdown = () => close();
		shutdownSignal.addEventListener("abort", closeOnShutdown, { once: true });

		const load = (force = false) => {
			const adapter = tabs?.[activeTab];
			if (!adapter) return;
			const state = states.get(adapter.id) ?? { loading: false, revision: 0 };
			states.set(adapter.id, state);
			if (state.loading) return;
			const revision = ++state.revision;
			state.loading = true;
			render();
			fetchSnapshot(adapter, adapterContext, shutdownSignal, force)
				.then((snapshot) => {
					if (revision !== state.revision || viewSignal.aborted) return;
					state.snapshot = snapshot;
					state.error = undefined;
				})
				.catch((error: unknown) => {
					if (revision !== state.revision || viewSignal.aborted) return;
					state.snapshot = undefined;
					state.error = errorMessage(error);
				})
				.finally(() => {
					if (revision === state.revision) state.loading = false;
					render();
				});
		};
		const activateTab = (index: number) => {
			if (!tabs?.length) return;
			activeTab = (index + tabs.length) % tabs.length;
			scrollOffset = 0;
			const state = states.get(tabs[activeTab]!.id);
			if (!state?.snapshot && !state?.error) load();
			render();
		};

		void visibleAdapters(adapters, adapterContext).then((visible) => {
			if (viewSignal.aborted) return;
			tabs = visible;
			const preferred = visible.findIndex((adapter) => adapter.id === ctx.model?.provider);
			activateTab(preferred >= 0 ? preferred : 0);
			render();
		});

		const body = (width: number): FrameBody => {
			if (!tabs) return { head: [theme.fg("dim", "  Checking providers…")], band: [], foot: [] };
			if (!tabs.length) {
				return {
					head: [
						theme.fg("dim", "  No usage providers have credentials."),
						theme.fg("dim", "  Log in with /login, then reopen /usage."),
					],
					band: [],
					foot: [],
				};
			}
			const adapter = tabs[activeTab]!;
			return formatProviderBody(theme, adapter.title, states.get(adapter.id), width);
		};

		return {
			render: (width: number) => {
				const frame = formatScrollFrame(theme, {
					titles: tabs?.map((adapter) => adapter.title) ?? [],
					active: activeTab,
					...body(width),
					offset: scrollOffset,
					height: frameHeight(tui.terminal?.rows) - STATUSLINE_RESERVE,
				}, width);
				// Clamp after any refresh or height change; the geometry feeds page scrolling.
				scrollOffset = frame.offset;
				bandView = { bandSize: frame.bandSize, maxOffset: frame.maxOffset };
				return frame.lines;
			},
			invalidate: render,
			dispose: () => {
				shutdownSignal.removeEventListener("abort", closeOnShutdown);
				viewController.abort();
			},
			handleInput: (data: string) => {
				if (viewSignal.aborted) return;
				if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) close();
				else if (matchesKey(data, "shift+tab")) activateTab(activeTab - 1);
				else if (matchesKey(data, "tab")) activateTab(activeTab + 1);
				else if (data.toLowerCase() === "r") load(true);
				else if (matchesKey(data, "up") || data === "k") scroll(-1);
				else if (matchesKey(data, "down") || data === "j") scroll(1);
				// Terminal multiplexers (herdr among them) swallow PgUp/PgDn/Home/End before they reach
				// the app, so the same moves are also bound to plain characters that always arrive.
				else if (matchesKey(data, "pageup") || data === "K") scroll(-bandView.bandSize);
				else if (matchesKey(data, "pagedown") || data === "J") scroll(bandView.bandSize);
				else if (matchesKey(data, "home") || data === "g") scrollTo(0);
				else if (matchesKey(data, "end") || data === "G") scrollTo(Number.POSITIVE_INFINITY);
			},
		};
	});
}

export const __testing = Object.freeze({
	computeStatus,
	createAdapterContext,
	fetchSnapshot,
	openUsage,
	setStatus,
	visibleAdapters,
	clearSnapshotCache: () => snapshotCache.clear(),
});

export default function usage(pi: ExtensionAPI) {
	let generation = 0;
	let shutdownController = new AbortController();

	const clearStatus = (ctx?: ExtensionContext) => {
		generation += 1;
		if (ctx) setStatus(ctx);
	};
	const refreshStatus = async (ctx: ExtensionContext) => {
		const currentGeneration = ++generation;
		if (!ctx.hasUI) return;
		const signal = shutdownController.signal;
		let text: string | undefined;
		try { text = await computeStatus(ctx, PROVIDER_ADAPTERS, createAdapterContext(ctx), signal); }
		catch { text = undefined; }
		if (currentGeneration !== generation || signal.aborted) return;
		setStatus(ctx, text);
	};

	pi.registerCommand("usage", {
		description: "Show provider quota usage (used percentages) in a tabbed view",
		handler: async (_args, ctx) => {
			const signal = shutdownController.signal;
			await openUsage(ctx, signal);
			if (!signal.aborted && signal === shutdownController.signal) void refreshStatus(ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		shutdownController.abort();
		shutdownController = new AbortController();
		snapshotCache.clear();
		resetManagementKeyCache();
		void refreshStatus(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		void refreshStatus(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		void refreshStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		shutdownController.abort();
		clearStatus(ctx);
	});
}
