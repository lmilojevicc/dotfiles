/**
 * Claude subscription quota.
 *
 * Two sources, both read-only:
 *
 * 1. **Live headers** — `pi-claude-bridge` (and pi's built-in provider) hand Claude Code's
 *    `rate_limit_event` to extensions as `anthropic-ratelimit-unified-*` headers on
 *    `after_provider_response`. Those are free and current, so the menu and footer prefer
 *    them when a Claude request has happened in this session; utilizations are fractions.
 * 2. **OAuth usage endpoint** — `GET https://api.anthropic.com/api/oauth/usage` with the
 *    Claude Code login. This is what `/usage` shows, and it works even when no Claude
 *    request has been made. It is the only source used by a manual refresh.
 *
 * The credential is only ever read, never refreshed here: Claude Code owns that lifecycle, and
 * rotating its refresh token from a second process would risk breaking the user's login. An
 * expired token is reported as an auth-refresh state instead. Neither source logs the token.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	displayText,
	type AdapterContext,
	type ProviderAdapter,
	type ProviderSnapshot,
	type UsageRow,
	ProviderStateError,
} from "../core.ts";
import { fetchBoundedJson, requestSignal } from "../network.ts";

const execFileAsync = promisify(execFile);

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_ENV = "PI_USAGE_CLAUDE_CREDENTIALS";
const TOKEN_ENV = "PI_USAGE_CLAUDE_TOKEN";
/** Header prefix documented by pi-claude-bridge; the built-in provider uses the same names. */
const HEADER_PREFIX = "anthropic-ratelimit-unified-";
/** Claude Code's window names, and the abbreviations it uses in those headers. */
const WINDOW_ABBREVIATIONS: Readonly<Record<string, string>> = {
	five_hour: "5h",
	seven_day: "7d",
	seven_day_overage_included: "7d_oi",
};
/** Window shorthands for the live-header path, keyed by the abbreviation in the header name. */
const HEADER_WINDOWS: Readonly<Record<string, string>> = {
	"5h": "5h",
	"7d": "weekly",
	"7d_oi": "weekly · overage",
};
const TOKEN_CACHE_MS = 60_000;
const TOKEN_MIN_VALIDITY_MS = 2 * 60_000;

type ClaudeCredential = { token: string; expiresAtMs?: number; subscriptionType?: string };

let cachedCredential: { value?: ClaudeCredential; expiresAt: number } | undefined;

/** Test seam: forget the cached credential so the next read hits the store again. */
export function resetClaudeCredentialCache(): void {
	cachedCredential = undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** ISO timestamp or epoch (seconds/ms) to epoch seconds. */
function epochSeconds(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value > 1e11 ? value / 1000 : value;
	const raw = text(value);
	if (!raw) return undefined;
	const numeric = Number(raw);
	if (Number.isFinite(numeric) && /^-?\d+(\.\d+)?$/.test(raw)) return numeric > 1e11 ? numeric / 1000 : numeric;
	const parsed = Date.parse(raw);
	return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

/**
 * The endpoint reports `utilization` in whole percent (38 means 38%), while the equivalent rate-limit
 * headers use fractions. Values above 1 are unambiguous; a value at or below 1 could be either, so
 * callers pass `limits[].percent` when the response carries it and this stays the fallback.
 */
function normalizeUtilization(value: number | undefined, treatAtMostOneAsFraction: boolean): number | undefined {
	if (value === undefined) return undefined;
	if (value > 1) return value;
	if (value === 1) return treatAtMostOneAsFraction ? 100 : 1;
	return treatAtMostOneAsFraction ? value * 100 : value;
}

/** macOS keychain read; disabled by the injectable seam so tests never touch the real login. */
async function readDarwinKeychain(service: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-w"], {
			timeout: 5_000,
			maxBuffer: 64 * 1024,
		});
		return stdout;
	} catch {
		return undefined;
	}
}

async function readCredentialFile(path: string): Promise<ClaudeCredential | undefined> {
	try {
		const parsed = record(JSON.parse(await readFile(path, "utf8")));
		const oauth = record(parsed?.claudeAiOauth);
		const token = text(oauth?.accessToken);
		if (!token) return undefined;
		return {
			token,
			expiresAtMs: number(oauth?.expiresAt),
			...(text(oauth?.subscriptionType) === undefined ? {} : { subscriptionType: text(oauth?.subscriptionType)! }),
		};
	} catch {
		return undefined;
	}
}

/** Claude Code's own credential store: the macOS keychain, else `~/.claude/.credentials.json`. */
async function readCredential(ctx: AdapterContext): Promise<ClaudeCredential | undefined> {
	const envToken = text(ctx.env[TOKEN_ENV]);
	if (envToken) return { token: envToken };
	const explicit = text(ctx.env[CREDENTIALS_ENV]);
	if (explicit) return await readCredentialFile(explicit);
	const item = ctx.readKeychainItem
		? await ctx.readKeychainItem(KEYCHAIN_SERVICE)
		: process.platform === "darwin"
			? await readDarwinKeychain(KEYCHAIN_SERVICE)
			: undefined;
	if (item !== undefined) {
		try {
			const parsed = record(JSON.parse(item.trim()));
			const oauth = record(parsed?.claudeAiOauth);
			const token = text(oauth?.accessToken);
			if (token) {
				return {
					token,
					expiresAtMs: number(oauth?.expiresAt),
					...(text(oauth?.subscriptionType) === undefined ? {} : { subscriptionType: text(oauth?.subscriptionType)! }),
				};
			}
		} catch {
			// Fall through to the file store; a malformed item is not fatal.
		}
	}
	return await readCredentialFile(join(ctx.homeDir, ".claude", ".credentials.json"));
}

async function credential(ctx: AdapterContext): Promise<ClaudeCredential | undefined> {
	if (cachedCredential && cachedCredential.expiresAt > Date.now()) return cachedCredential.value;
	const value = await readCredential(ctx);
	cachedCredential = { value, expiresAt: Date.now() + TOKEN_CACHE_MS };
	return value;
}

function expired(credential: ClaudeCredential): boolean {
	return credential.expiresAtMs !== undefined && credential.expiresAtMs - Date.now() < TOKEN_MIN_VALIDITY_MS;
}

/** Rows from the normalized `limits[]` array, which is the endpoint's clearest statement of quota. */
function limitRows(payload: Record<string, unknown>): { rows: UsageRow[]; worst?: string } {
	const limits = Array.isArray(payload.limits) ? payload.limits : [];
	const rows: UsageRow[] = [];
	let worst: string | undefined;
	for (const entry of limits) {
		const limit = record(entry);
		if (!limit) continue;
		const kind = text(limit.kind) ?? text(limit.group) ?? "limit";
		const percent = number(limit.percent);
		const resetsAt = epochSeconds(limit.resets_at);
		const severity = text(limit.severity);
		const scope = text(limit.scope);
		const label = kind === "session"
			? "5h session"
			: kind === "weekly_all"
				? "weekly · all models"
				: kind.startsWith("weekly")
					? `weekly · ${scope ?? kind.replace(/^weekly_?/, "")}`.replace(/·\s*$/, "· scoped")
					: kind;
		const window = kind === "session" ? "5h" : kind.startsWith("weekly") ? "weekly" : "limit";
		rows.push({
			label,
			windows: [{ label: window, ...(percent === undefined ? {} : { usedPercent: percent }), ...(resetsAt === undefined ? {} : { resetsAt }) }],
			...(severity && severity !== "normal" ? { state: severity } : {}),
		});
		if (severity && severity !== "normal") worst = severity;
	}
	return { rows, ...(worst === undefined ? {} : { worst }) };
}

/** Fallback rows from the raw window buckets when `limits[]` is absent or empty. */
function bucketRows(payload: Record<string, unknown>): UsageRow[] {
	const buckets: Array<[string, string]> = [
		["five_hour", "5h"],
		["seven_day", "weekly"],
		["seven_day_sonnet", "weekly · Sonnet"],
		["seven_day_opus", "weekly · Opus"],
	];
	const rows: UsageRow[] = [];
	for (const [key, label] of buckets) {
		const bucket = record(payload[key]);
		if (!bucket) continue;
		const percent = normalizeUtilization(number(bucket.utilization), true);
		const resetsAt = epochSeconds(bucket.resets_at);
		if (percent === undefined && resetsAt === undefined) continue;
		rows.push({
			label,
			windows: [{ label: key === "five_hour" ? "5h" : "weekly", ...(percent === undefined ? {} : { usedPercent: percent }), ...(resetsAt === undefined ? {} : { resetsAt }) }],
			...(text(bucket.locked_reason) ? { state: text(bucket.locked_reason)! } : {}),
		});
	}
	return rows;
}

/** App-level share of weekly usage; labelled as a share so it is not read as a limit. */
function breakdownRows(payload: Record<string, unknown>): UsageRow[] {
	const rows = Array.isArray(record(payload.seven_day_breakdown)?.rows) ? (record(payload.seven_day_breakdown)!.rows as unknown[]) : [];
	const out: UsageRow[] = [];
	for (const entry of rows) {
		const row = record(entry);
		if (!row) continue;
		const name = displayText(row.display_name ?? row.key, 24);
		const percent = number(row.percent);
		if (!name || percent === undefined) continue;
		out.push({ group: "Weekly usage share", label: name, windows: [{ label: "share", usedPercent: percent, note: "of weekly usage" }] });
	}
	return out;
}

/** Pay-as-you-go credits, shown only when the account has them enabled. */
function creditRows(payload: Record<string, unknown>): UsageRow[] {
	const rows: UsageRow[] = [];
	const spend = record(payload.spend);
	if (spend && spend.enabled === true) {
		const percent = number(spend.percent);
		const used = record(spend.used);
		const limit = record(spend.limit);
		const money = (value: Record<string, unknown> | undefined) => {
			const amount = number(value?.amount_minor);
			const exponent = number(value?.exponent) ?? 2;
			const currency = text(value?.currency) ?? "USD";
			return amount === undefined ? undefined : `${currency} ${(amount / 10 ** exponent).toFixed(exponent)}`;
		};
		const usedText = money(used);
		const limitText = money(limit);
		rows.push({
			group: "Credits",
			label: "extra usage",
			windows: [{ label: "spend", ...(percent === undefined ? {} : { usedPercent: percent }) }],
			...(usedText || limitText ? { state: [usedText, limitText].filter(Boolean).join(" / ") } : {}),
		});
	}
	const extra = record(payload.extra_usage);
	if (extra && extra.is_enabled === true) {
		const percent = number(extra.utilization);
		const limit = number(extra.monthly_limit);
		const used = number(extra.used_credits);
		rows.push({
			group: "Credits",
			label: "extra usage (monthly)",
			windows: [{ label: "credits", ...(percent === undefined ? {} : { usedPercent: percent }) }],
			...(limit === undefined ? {} : { state: `${used ?? 0} of ${limit} credits` }),
		});
	}
	return rows;
}

/** Parse the OAuth usage payload. Never throws: unknown shapes render as `?%` plus a note. */
export function parseClaudeUsagePayload(payload: unknown): ProviderSnapshot {
	const root = record(payload) ?? {};
	const limits = limitRows(root);
	// Quota rows drive the footer maximum; shares and credits are decorative rows appended after them.
	const quotaRows: UsageRow[] = limits.rows.length ? [...limits.rows] : bucketRows(root);
	const rows: UsageRow[] = [...quotaRows, ...breakdownRows(root), ...creditRows(root)];
	const notes: string[] = [];
	if (!rows.length) notes.push("Claude returned no usage windows.");
	if (limits.worst !== undefined) notes.push(`severity: ${displayText(limits.worst, 24)}`);
	const subscription = text(root.subscription_type);
	const known = quotaRows.map((row) => row.windows[0]?.usedPercent).filter((value): value is number => value !== undefined && Number.isFinite(value));
	const statusPercent = known.length ? Math.max(...known) : undefined;
	return {
		providerId: "claude",
		title: "Claude",
		...(subscription === undefined ? {} : { subtitle: subscription }),
		rows,
		...(notes.length ? { notes } : {}),
		observedAt: Math.floor(Date.now() / 1000),
		...(statusPercent === undefined || !Number.isFinite(statusPercent) ? {} : { statusPercent }),
	};
}

/**
 * Build a snapshot from the unified rate-limit headers. Returns undefined when the response carries
 * no Claude rate-limit headers (any other provider, or a response before Claude Code reported one).
 */
export function parseClaudeHeaders(headers: Readonly<Record<string, string>> | undefined): ProviderSnapshot | undefined {
	if (!headers) return undefined;
	const lookup = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const rows: UsageRow[] = [];
	for (const [abbreviation, label] of Object.entries(HEADER_WINDOWS)) {
		const utilization = lookup.get(`${HEADER_PREFIX}${abbreviation}-utilization`);
		const reset = lookup.get(`${HEADER_PREFIX}${abbreviation}-reset`);
		if (utilization === undefined && reset === undefined) continue;
		const usedPercent = normalizeUtilization(utilization === undefined ? undefined : Number(utilization), true);
		const resetsAt = epochSeconds(reset);
		if (usedPercent === undefined && resetsAt === undefined) continue;
		rows.push({
			label,
			windows: [{ label, ...(usedPercent === undefined ? {} : { usedPercent }), ...(resetsAt === undefined ? {} : { resetsAt }) }],
		});
	}
	if (!rows.length) return undefined;
	const status = lookup.get(`${HEADER_PREFIX}status`);
	const overage = lookup.get(`${HEADER_PREFIX}overage-status`);
	const claim = lookup.get(`${HEADER_PREFIX}representative-claim`);
	const notes: string[] = ["Live from Claude rate-limit headers"];
	if (status && status !== "allowed") notes.push(`limit status: ${displayText(status, 24)}`);
	if (overage && overage !== "allowed") notes.push(`overage: ${displayText(overage, 24)}`);
	const statusPercent = Math.max(...rows.map((row) => row.windows[0]?.usedPercent ?? Number.NEGATIVE_INFINITY));
	return {
		providerId: "claude",
		title: "Claude",
		rows,
		notes,
		observedAt: Math.floor(Date.now() / 1000),
		...(claim === undefined ? {} : { subtitle: displayText(claim, 24) }),
		...(Number.isFinite(statusPercent) ? { statusPercent } : {}),
	};
}

export const claudeAdapter: ProviderAdapter = {
	id: "claude",
	title: "Claude",
	aliases: ["claude-bridge", "anthropic"],
	async hasCredentials(ctx: AdapterContext): Promise<boolean> {
		// Presence keeps the tab visible, like the other adapters: an expired login must still be
		// discoverable, and says what to do when it is opened.
		return (await credential(ctx)) !== undefined;
	},
	async fetch(ctx: AdapterContext, signal?: AbortSignal): Promise<ProviderSnapshot> {
		const found = await credential(ctx);
		if (!found) throw new ProviderStateError("setup", "No Claude login found · run claude");
		if (expired(found)) throw new ProviderStateError("auth-refresh", "Claude token expired · run claude to refresh");
		const payload = await fetchBoundedJson(USAGE_URL, {
			method: "GET",
			headers: {
				authorization: `Bearer ${found.token}`,
				accept: "application/json",
				"anthropic-beta": "oauth-2025-04-20",
				"user-agent": "claude-code/usage-extension",
			},
			...(signal === undefined ? {} : { signal }),
		}, { fetch: ctx.fetch, label: "Claude" });
		const snapshot = parseClaudeUsagePayload(payload);
		return found.subscriptionType === undefined || snapshot.subtitle !== undefined
			? snapshot
			: { ...snapshot, subtitle: found.subscriptionType };
	},
};
