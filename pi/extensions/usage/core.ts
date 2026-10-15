/**
 * Provider adapter contract for the `usage` extension.
 *
 * Every adapter lives in `providers/<id>.ts` and is registered once in
 * `providers/index.ts`. Adapters return plain data; the framework owns all
 * rendering, caching, footer publication and width fitting.
 *
 * Rules every adapter must follow:
 * - Percentages are **used** (consumed) percentages, never "left". Keep the raw,
 *   unrounded provider value; the framework clamps and rounds for display only.
 * - All timestamps in this contract are epoch **seconds**.
 * - Never put credentials, tokens, management keys or auth headers in a
 *   snapshot, note, state or thrown error message.
 */

export const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
export const FIVE_HOUR_WINDOW_MINUTES = 5 * 60;

export type UsageWindow = {
	/** Short window label, e.g. "5h", "weekly", "Monthly". */
	label: string;
	/** Raw used percentage as reported (may be <0, >100 or fractional); undefined renders `?%`. */
	usedPercent?: number;
	/** Epoch seconds when the window resets. */
	resetsAt?: number;
	/** Short human note shown beside the window, e.g. "rate-limited". */
	note?: string;
};

export type UsageRow = {
	label: string;
	windows: UsageWindow[];
	/** Short state text, e.g. "ok", "disabled", "cooling down until 14:05". */
	state?: string;
	/** Rows sharing a group are rendered under one group heading, in first-seen order. */
	group?: string;
};

export type ProviderSnapshot = {
	providerId: string;
	title: string;
	/** Shown after the title, e.g. the plan type. */
	subtitle?: string;
	rows: UsageRow[];
	/** Dim notes rendered below the table. */
	notes?: string[];
	/** Epoch seconds when the data was observed. */
	observedAt: number;
	/**
	 * Raw used percentage published to the footer. When omitted the footer uses
	 * the highest known `usedPercent` of the first row that has one.
	 */
	statusPercent?: number;
};

export type ProviderAuth = { apiKey?: string; baseUrl?: string };

export type AdapterContext = {
	/** Pi's freshly resolved provider auth; undefined when Pi cannot resolve it (missing or needs refresh). */
	getProviderAuth(providerId: string): Promise<ProviderAuth | undefined>;
	/** True when Pi has credentials stored or configured for the provider, without resolving or refreshing them. */
	hasProviderCredentials(providerId: string): boolean;
	/** Pi agent directory (`~/.pi/agent` or `$PI_CODING_AGENT_DIR`). */
	agentDir: string;
	homeDir: string;
	env: Readonly<Record<string, string | undefined>>;
	/** Use this instead of the global fetch so tests never perform real network I/O. */
	fetch: typeof globalThis.fetch;
};

export type ProviderAdapter = {
	/** Pi provider id where one exists; the footer prefers the adapter whose id equals the session model's provider. */
	id: string;
	/** Tab label. Keep it short. */
	title: string;
	/** True when this provider has usable credentials configured (any state). Gate on presence, not readiness. */
	hasCredentials(ctx: AdapterContext): Promise<boolean>;
	/** Fetch a snapshot. Throw Error with a short human message on failure (see ProviderStateError). */
	fetch(ctx: AdapterContext, signal?: AbortSignal): Promise<ProviderSnapshot>;
};

/**
 * Throw from `fetch` for expected, non-retryable-by-itself states. The tab
 * renders the message as a warning instead of a red request failure.
 * - `auth-refresh`: credentials are present but Pi could not resolve them.
 * - `setup`: local configuration is missing (e.g. no management key).
 * - `blocked`: the provider temporarily refuses this host.
 */
export class ProviderStateError extends Error {
	readonly state: "auth-refresh" | "setup" | "blocked";
	constructor(state: ProviderStateError["state"], message: string) {
		super(message);
		this.name = "ProviderStateError";
		this.state = state;
	}
}

/** Resolve Pi provider auth or throw the "auth needs refresh" state. */
export async function requireProviderAuth(ctx: AdapterContext, providerId: string): Promise<ProviderAuth & { apiKey: string }> {
	const auth = await ctx.getProviderAuth(providerId);
	if (!auth?.apiKey) throw new ProviderStateError("auth-refresh", `Auth needs refresh · run /login ${providerId}`);
	return { ...auth, apiKey: auth.apiKey };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Strict: only finite JSON numbers; numeric strings are not accepted. */
export function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Epoch seconds from an epoch number (seconds or milliseconds) or a date string. */
export function epochSeconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value > 1e12 ? Math.floor(value / 1000) : value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed / 1000) : undefined;
}

/** Provider text shown in the UI: single line, no control characters, bounded length. */
export function displayText(value: unknown, maxLength = 80): string | undefined {
	const text = stringValue(value)?.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export function clampUsedPercent(usedPercent: number): number {
	return Math.max(0, Math.min(100, usedPercent));
}

export function formatUsedPercent(usedPercent: number | undefined): string {
	return usedPercent === undefined ? "?%" : `${Math.round(clampUsedPercent(usedPercent))}%`;
}

export function usageBar(usedPercent: number | undefined): string {
	if (usedPercent === undefined) return "░░░░░░░░░░";
	const filled = Math.max(0, Math.min(10, Math.round(clampUsedPercent(usedPercent) / 10)));
	return "█".repeat(filled) + "░".repeat(10 - filled);
}

export function formatResetShort(timestampSeconds: number | undefined, now = Date.now()): string {
	if (!timestampSeconds) return "reset ?";
	const remainingMs = timestampSeconds * 1000 - now;
	if (remainingMs <= 0) return "~now";
	const minutes = Math.ceil(remainingMs / 60_000);
	if (minutes < 60) return `~${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `~${hours}h`;
	return `~${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Local wall-clock time; includes the date when it is not today. */
export function formatClock(timestampSeconds: number, now = Date.now()): string {
	const date = new Date(timestampSeconds * 1000);
	const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
	const today = new Date(now);
	if (date.toDateString() === today.toDateString()) return time;
	return `${date.toLocaleString("en-US", { month: "short" })} ${date.getDate()} ${time}`;
}

/** "5h" / "weekly" for the canonical windows, otherwise a compact duration; `fallback` when unknown. */
export function windowLabel(windowMinutes: number | undefined, fallback = "window"): string {
	if (windowMinutes === undefined || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return fallback;
	if (windowMinutes === FIVE_HOUR_WINDOW_MINUTES) return "5h";
	if (windowMinutes === WEEKLY_WINDOW_MINUTES) return "weekly";
	if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
	if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
	return `${Math.round(windowMinutes)}m`;
}

/** The raw used percentage the footer publishes for a snapshot, if any. */
export function statusUsedPercent(snapshot: ProviderSnapshot): number | undefined {
	if (snapshot.statusPercent !== undefined && Number.isFinite(snapshot.statusPercent)) return snapshot.statusPercent;
	for (const row of snapshot.rows) {
		const known = row.windows.map((window) => window.usedPercent).filter((value): value is number => value !== undefined && Number.isFinite(value));
		if (known.length) return Math.max(...known);
	}
	return undefined;
}

export function formatStatus(providerId: string, usedPercent: number): string {
	return `${providerId} ${Math.round(clampUsedPercent(usedPercent))}% used`;
}
