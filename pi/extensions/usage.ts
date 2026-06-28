/**
 * Consolidated usage extension for pi
 *
 * Registers /usage with tabbed UI (Cursor, GLM, OpenCode Go) and refreshes
 * per-provider footer status every 45 seconds.
 *
 * Reload after edits with: /reload
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

const REFRESH_MS = 45_000;

const CURSOR_STATUS_KEY = "cursor-usage";
const GLM_STATUS_KEY = "glm-usage";
const OPENCODE_GO_STATUS_KEY = "opencode-go-usage";

const CURSOR_BEARER_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const CURSOR_COOKIE_URL = "https://cursor.com/api/usage-summary";
const CURSOR_DB_KEY_ACCESS_TOKEN = "cursorAuth/accessToken";

const GLM_QUOTA_URL = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_DASHBOARD_URL_PREFIX = "https://opencode.ai/workspace/";
const OPENCODE_GO_DASHBOARD_URL_SUFFIX = "/go";
const OPENCODE_GO_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

interface UsageWindow {
	usedPercent: number;
	remainingPercent: number;
	resetInSec?: number;
	resetAtMs?: number;
}

const usageSections = ["cursor", "glm", "opencode-go"] as const;
type UsageSection = (typeof usageSections)[number];

type Timer = ReturnType<typeof setInterval>;

interface PlanUsage {
	autoPercentUsed?: number;
	apiPercentUsed?: number;
	totalPercentUsed?: number;
	totalSpend?: number;
	includedSpend?: number;
	limit?: number;
	remaining?: number;
}

interface CursorUsage {
	auto: number;
	api: number;
	total?: number;
	plan?: PlanUsage;
	billingCycleStart?: string;
	billingCycleEnd?: string;
}

interface QuotaLimit {
	type: string;
	unit?: number;
	number?: number;
	usage?: number;
	currentValue?: number;
	remaining?: number;
	percentage?: number;
	nextResetTime?: string;
	usageDetails?: Array<{ modelCode: string; usage: number }>;
}

interface GlmQuotaData {
	level?: string;
	limits?: QuotaLimit[];
}

interface OpenCodeGoUsage {
	rolling?: UsageWindow;
	weekly?: UsageWindow;
	monthly?: UsageWindow;
	plan?: string;
	source: "api" | "scrape";
}

interface ProviderResult<T> {
	ok: true;
	data: T;
}

interface ProviderError {
	ok: false;
	error: string;
}

type LoadResult<T> = ProviderResult<T> | ProviderError;

function isProviderError<T>(result: LoadResult<T>): result is ProviderError {
	return !result.ok;
}

interface UsageCache {
	cursor: LoadResult<CursorUsage>;
	glm: LoadResult<GlmQuotaData>;
	opencodeGo: LoadResult<OpenCodeGoUsage>;
}

const sectionLabels: Record<UsageSection, string> = {
	cursor: "Cursor",
	glm: "GLM",
	"opencode-go": "OpenCode Go",
};

class NoAuthError extends Error {
	constructor(message = "no auth") {
		super(message);
		this.name = "NoAuthError";
	}
}

function safeThemeFg(theme: ExtensionContext["ui"]["theme"], color: string, text: string): string {
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function setStatus(ctx: ExtensionContext, key: string, text?: string): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setStatus(key, text);
	} catch {
		// UI context can become stale during reload/shutdown.
	}
}

function formatPct(n: number): string {
	return Math.round(n).toString();
}

function formatUsdCents(cents: number): string {
	return `$${(cents / 100).toFixed(2)}`;
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

function formatBillingCycleEnd(value: string): string {
	const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
	return Number.isFinite(ms) ? new Date(ms).toLocaleString() : value;
}

function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

function formatDuration(seconds: number): string {
	if (seconds <= 0) return "now";
	if (seconds < 60) return `${Math.round(seconds)}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
	return `${(seconds / 86_400).toFixed(1)}d`;
}

function parseResetTimestamp(value: string | number | undefined): number | undefined {
	if (value == null) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1_000_000_000_000 ? value : value * 1000;
	}
	const trimmed = String(value).trim();
	if (!trimmed) return undefined;
	const ms = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
	return Number.isFinite(ms) ? ms : undefined;
}

function formatResetLabel(resetAtMs?: number, resetInSec?: number): string | undefined {
	if (resetAtMs != null) {
		const diffSec = Math.max(0, Math.round((resetAtMs - Date.now()) / 1000));
		if (diffSec <= 0) return "Resets now";
		return `Resets in ${formatDuration(diffSec)} (${new Date(resetAtMs).toLocaleString()})`;
	}
	if (resetInSec != null && resetInSec >= 0) {
		return resetInSec === 0 ? "Resets now" : `Resets in ${formatDuration(resetInSec)}`;
	}
	return undefined;
}

function buildUsageWindow(usedPercent: number, resetInSec?: number, resetAtMs?: number): UsageWindow {
	const used = clampPercent(usedPercent);
	const resetMs =
		resetAtMs ?? (resetInSec != null && resetInSec >= 0 ? Date.now() + resetInSec * 1000 : undefined);
	return {
		usedPercent: used,
		remainingPercent: clampPercent(100 - used),
		resetInSec: resetInSec != null ? Math.max(0, resetInSec) : undefined,
		resetAtMs: resetMs,
	};
}

function appendUsageWindowLines(lines: string[], label: string, window: UsageWindow | undefined): void {
	if (!window) return;
	lines.push("");
	lines.push(`${label}:`);
	lines.push(`  Used: ${window.usedPercent.toFixed(0)}%`);
	lines.push(`  Remaining: ${window.remainingPercent.toFixed(0)}%`);
	const reset = formatResetLabel(window.resetAtMs, window.resetInSec);
	if (reset) lines.push(`  ${reset}`);
}

function pctOf(limit: QuotaLimit | undefined): number {
	if (!limit) return 0;
	if (typeof limit.percentage === "number") return limit.percentage;
	const total = limit.usage ?? 0;
	const used = limit.currentValue ?? 0;
	return total ? (used / total) * 100 : 0;
}

function getOpencodeDataDir(): string {
	const home = homedir();
	const base = process.env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
	return join(base, "opencode");
}

function getOpencodeConfigDirs(): string[] {
	const home = homedir();
	const configBase = process.env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
	const dirs = [join(configBase, "opencode")];
	if (process.platform === "darwin") {
		dirs.push(join(home, "Library", "Application Support", "opencode"));
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim() || join(home, "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
		dirs.push(join(appData, "opencode"), join(localAppData, "opencode"));
	}
	return [...new Set(dirs)];
}

function getStateDbPath(): string {
	const home = homedir();
	if (process.platform === "darwin") {
		return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
		return join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
	}
	return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function normalizeStateValue(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function queryStateDb(key: string): string | undefined {
	const dbPath = getStateDbPath();
	if (!existsSync(dbPath)) return undefined;
	const sanitizedKey = key.replace(/'/g, "''");
	try {
		const result = execFileSync(
			"sqlite3",
			[dbPath, `SELECT value FROM ItemTable WHERE key='${sanitizedKey}'`],
			{ encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "ignore"] },
		);
		return normalizeStateValue(result);
	} catch {
		return undefined;
	}
}

async function readAccessTokenFromDb(): Promise<string | undefined> {
	const dbPath = getStateDbPath();
	if (!existsSync(dbPath)) return undefined;

	try {
		const mod = await import("better-sqlite3");
		const Database = mod.default;
		const db = new Database(dbPath, { readonly: true });
		try {
			const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(CURSOR_DB_KEY_ACCESS_TOKEN) as
				| { value?: string }
				| undefined;
			const value = row?.value;
			return value ? normalizeStateValue(value) : undefined;
		} finally {
			db.close();
		}
	} catch {
		return queryStateDb(CURSOR_DB_KEY_ACCESS_TOKEN);
	}
}

function extractPlanUsage(payload: unknown): PlanUsage | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const obj = payload as Record<string, unknown>;

	if (obj.planUsage && typeof obj.planUsage === "object") {
		return obj.planUsage as PlanUsage;
	}
	if (obj.data && typeof obj.data === "object") {
		const data = obj.data as Record<string, unknown>;
		if (data.planUsage && typeof data.planUsage === "object") {
			return data.planUsage as PlanUsage;
		}
	}
	if (obj.individualUsage && typeof obj.individualUsage === "object") {
		const usage = obj.individualUsage as Record<string, unknown>;
		if (usage.plan && typeof usage.plan === "object") {
			return usage.plan as PlanUsage;
		}
	}
	return undefined;
}

function parseCursorUsage(payload: unknown): CursorUsage | undefined {
	const plan = extractPlanUsage(payload);
	if (!plan) return undefined;

	const auto = plan.autoPercentUsed;
	const api = plan.apiPercentUsed;
	if (typeof auto !== "number" || typeof api !== "number" || !Number.isFinite(auto) || !Number.isFinite(api)) {
		return undefined;
	}

	const obj = payload as Record<string, unknown>;
	const billingCycleStart =
		typeof obj.billingCycleStart === "string" ? obj.billingCycleStart : undefined;
	const billingCycleEnd = typeof obj.billingCycleEnd === "string" ? obj.billingCycleEnd : undefined;
	const total =
		typeof plan.totalPercentUsed === "number" && Number.isFinite(plan.totalPercentUsed)
			? plan.totalPercentUsed
			: undefined;
	return {
		auto,
		api,
		total,
		plan,
		billingCycleStart,
		billingCycleEnd,
	};
}

async function fetchBearerCursorUsage(accessToken: string): Promise<CursorUsage> {
	const res = await fetch(CURSOR_BEARER_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Connect-Protocol-Version": "1",
			Authorization: `Bearer ${accessToken}`,
		},
		body: "{}",
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Cursor API returned ${res.status}`);
	const payload = await res.json();
	const parsed = parseCursorUsage(payload);
	if (!parsed) throw new Error("unexpected bearer response");
	return parsed;
}

async function fetchCookieCursorUsage(sessionToken: string): Promise<CursorUsage> {
	const res = await fetch(CURSOR_COOKIE_URL, {
		headers: {
			Cookie: `WorkosCursorSessionToken=${sessionToken}`,
			Origin: "https://cursor.com",
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`Cursor API returned ${res.status}`);
	const payload = await res.json();
	const parsed = parseCursorUsage(payload);
	if (!parsed) throw new Error("unexpected cookie response");
	return parsed;
}

async function getCursorSessionToken(): Promise<string | undefined> {
	const fromEnv = process.env.CURSOR_SESSION_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const config = await readUsageExtensionConfig();
	return config.cursorSessionToken?.trim() || undefined;
}

async function hasCursorAuth(): Promise<boolean> {
	if (await readAccessTokenFromDb()) return true;
	if (await getCursorSessionToken()) return true;
	if (await readPiAuthCredential("cursor")) return true;
	return false;
}

async function fetchCursorUsage(): Promise<CursorUsage> {
	const accessToken = (await readAccessTokenFromDb()) ?? (await readPiAuthCredential("cursor"));
	const sessionToken = await getCursorSessionToken();

	if (accessToken) {
		try {
			return await fetchBearerCursorUsage(accessToken);
		} catch {
			if (sessionToken) return fetchCookieCursorUsage(sessionToken);
			throw new Error("fetch failed");
		}
	}

	if (sessionToken) return fetchCookieCursorUsage(sessionToken);
	throw new NoAuthError();
}

function formatCursorStatus(usage: CursorUsage): string {
	const total = usage.total ?? usage.plan?.totalPercentUsed;
	const parts = [`Cursor Auto:${formatPct(usage.auto)}% API:${formatPct(usage.api)}%`];
	if (total != null && Number.isFinite(total)) parts.push(`M:${formatPct(total)}%`);
	return parts.join(" ");
}

function cursorDetailLines(usage: CursorUsage): string[] {
	const lines: string[] = ["Cursor Usage", ""];
	const monthlyResetMs = parseResetTimestamp(usage.billingCycleEnd);
	const monthlyReset = formatResetLabel(monthlyResetMs);
	const total = usage.total ?? usage.plan?.totalPercentUsed;

	if (total != null && Number.isFinite(total)) {
		lines.push(`Monthly total: ${formatPct(total)}%`);
		if (monthlyReset) lines.push(`  ${monthlyReset}`);
	}

	lines.push("");
	lines.push(`Auto (monthly cycle): ${formatPct(usage.auto)}%`);
	if (monthlyReset) lines.push(`  ${monthlyReset}`);
	lines.push(`API (monthly cycle): ${formatPct(usage.api)}%`);
	if (monthlyReset) lines.push(`  ${monthlyReset}`);

	const plan = usage.plan;
	if (plan?.includedSpend != null && plan?.limit != null) {
		lines.push("");
		lines.push(`Spend: ${formatUsdCents(plan.includedSpend)} / ${formatUsdCents(plan.limit)}`);
		if (plan.remaining != null) lines.push(`Remaining: ${formatUsdCents(plan.remaining)}`);
	} else if (plan?.totalSpend != null && plan?.limit != null) {
		lines.push("");
		lines.push(`Spend: ${formatUsdCents(plan.totalSpend)} / ${formatUsdCents(plan.limit)}`);
		if (plan.remaining != null) lines.push(`Remaining: ${formatUsdCents(plan.remaining)}`);
	}
	if (usage.billingCycleStart) {
		lines.push(`Cycle start: ${formatBillingCycleEnd(usage.billingCycleStart)}`);
	}
	if (usage.billingCycleEnd) {
		lines.push(`Cycle end: ${formatBillingCycleEnd(usage.billingCycleEnd)}`);
	}
	return lines;
}

async function fetchGlmQuota(apiKey: string): Promise<GlmQuotaData> {
	const res = await fetch(GLM_QUOTA_URL, {
		headers: {
			Authorization: apiKey,
			"Content-Type": "application/json",
			"Accept-Language": "en-US,en",
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!res.ok) throw new Error(`GLM API returned ${res.status}`);
	const payload = (await res.json()) as { data?: GlmQuotaData; msg?: string };
	if (!payload.data?.limits?.length) {
		throw new Error(payload.msg ?? "unexpected response");
	}
	return payload.data;
}

function findGlmLimits(data: GlmQuotaData): {
	weeklyLimit?: QuotaLimit;
	fiveHourLimit?: QuotaLimit;
	monthlyLimit?: QuotaLimit;
	tokenLimit?: QuotaLimit;
} {
	const limits = data.limits ?? [];
	return {
		fiveHourLimit: limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 3 && l.number === 5),
		weeklyLimit: limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 6 && l.number === 1),
		monthlyLimit: limits.find((l) => l.type === "TIME_LIMIT" && l.unit === 5 && l.number === 1),
		tokenLimit: limits.find((l) => l.type === "TOKENS_LIMIT"),
	};
}

function formatGlmStatus(data: GlmQuotaData): string {
	const { weeklyLimit, fiveHourLimit, monthlyLimit } = findGlmLimits(data);
	const weekPct = pctOf(weeklyLimit);
	const fiveHourPct = pctOf(fiveHourLimit);
	const monthPct = pctOf(monthlyLimit);
	const level = data.level ? data.level.toUpperCase() : "GLM";
	const parts = [`GLM ${level} 5h:${fiveHourPct.toFixed(0)}%`, `W:${weekPct.toFixed(0)}%`];
	if (monthlyLimit) parts.push(`M:${monthPct.toFixed(0)}%`);
	return parts.join(" ");
}

function glmDetailLines(data: GlmQuotaData): string[] {
	const lines: string[] = [];
	const level = data.level ? data.level.toUpperCase() : "GLM";
	lines.push(`GLM Coding Plan — ${level}`);

	const { weeklyLimit, fiveHourLimit, monthlyLimit, tokenLimit } = findGlmLimits(data);

	const appendLimit = (label: string, limit: QuotaLimit | undefined) => {
		if (!limit) return;
		const used = limit.currentValue ?? 0;
		const total = limit.usage ?? 0;
		const remaining = limit.remaining ?? (total ? total - used : undefined);
		const pct = pctOf(limit);
		lines.push("");
		lines.push(`${label}:`);
		if (total > 0 && limit.currentValue != null) {
			lines.push(`  Tokens: ${formatTokens(used)} / ${formatTokens(total)} (${pct.toFixed(1)}%)`);
			if (remaining != null) lines.push(`  Remaining: ${formatTokens(remaining)}`);
		} else if (limit.type === "TIME_LIMIT") {
			lines.push(`  Calls: ${formatTokens(used)} / ${formatTokens(total)} (${pct.toFixed(1)}%)`);
			if (remaining != null) lines.push(`  Remaining: ${formatTokens(remaining)}`);
		} else {
			lines.push(`  Used: ${pct.toFixed(1)}%`);
		}
		const reset = formatResetLabel(parseResetTimestamp(limit.nextResetTime));
		if (reset) lines.push(`  ${reset}`);
		if (limit.usageDetails?.length) {
			lines.push("  Per-model usage:");
			for (const m of limit.usageDetails) {
				lines.push(`    ${m.modelCode}: ${formatTokens(m.usage)}`);
			}
		}
	};

	appendLimit("5-hour window", fiveHourLimit);
	appendLimit("Weekly window", weeklyLimit);
	appendLimit("Monthly MCP tools", monthlyLimit);
	if (!weeklyLimit && !fiveHourLimit && !monthlyLimit) {
		appendLimit("Tokens", tokenLimit);
		if (!tokenLimit) lines.push("", "(no quota windows in response)");
	}

	return lines;
}

interface OpenCodeGoScrapeConfig {
	workspaceId: string;
	authCookie: string;
}

interface PiAuthCredential {
	type?: string;
	key?: string;
	access?: string;
}

interface UsageExtensionConfig {
	cursorSessionToken?: string;
}

interface OpenCodeGoScrapeFile {
	workspaceId?: string;
	authCookie?: string;
}

function getPiAgentDir(): string {
	return process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function getPiAuthPath(): string {
	return join(getPiAgentDir(), "auth.json");
}

function getUsageConfigPath(): string {
	return join(getPiAgentDir(), "usage-config.json");
}

function getDefaultOpenCodeGoScrapePath(): string {
	return join(getOpencodeConfigDirs()[0] ?? join(homedir(), ".config", "opencode"), "opencode-quota", "opencode-go.json");
}

async function readUsageExtensionConfig(): Promise<UsageExtensionConfig> {
	const path = getUsageConfigPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(await readFile(path, "utf8")) as UsageExtensionConfig;
	} catch {
		return {};
	}
}

async function writeUsageExtensionConfig(update: Partial<UsageExtensionConfig>): Promise<string> {
	const path = getUsageConfigPath();
	const current = await readUsageExtensionConfig();
	const next = { ...current, ...update };
	await mkdir(getPiAgentDir(), { recursive: true });
	await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	try {
		await chmod(path, 0o600);
	} catch {
		// best effort on platforms that ignore mode
	}
	return path;
}

async function writePiAuthCredential(provider: string, credential: PiAuthCredential): Promise<string> {
	const path = getPiAuthPath();
	let parsed: Record<string, PiAuthCredential> = {};
	if (existsSync(path)) {
		try {
			parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, PiAuthCredential>;
		} catch {
			parsed = {};
		}
	}
	parsed[provider] = credential;
	await mkdir(getPiAgentDir(), { recursive: true });
	await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
	try {
		await chmod(path, 0o600);
	} catch {
		// best effort
	}
	return path;
}

async function writeOpenCodeGoScrapeFile(config: OpenCodeGoScrapeConfig, path = getDefaultOpenCodeGoScrapePath()): Promise<string> {
	await mkdir(join(path, ".."), { recursive: true });
	const payload: OpenCodeGoScrapeFile = {
		workspaceId: config.workspaceId,
		authCookie: config.authCookie,
	};
	await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
	try {
		await chmod(path, 0o600);
	} catch {
		// best effort
	}
	return path;
}

async function readPiAuthCredential(provider: string): Promise<string | undefined> {
	const path = getPiAuthPath();
	if (!existsSync(path)) return undefined;
	try {
		const raw = await readFile(path, "utf8");
		const parsed = JSON.parse(raw) as Record<string, PiAuthCredential>;
		const credential = parsed[provider];
		if (!credential) return undefined;
		if (credential.key?.trim()) return credential.key.trim();
		if (credential.access?.trim()) return credential.access.trim();
	} catch {
		return undefined;
	}
	return undefined;
}

async function readOpenCodeGoBearerToken(): Promise<string | undefined> {
	const fromPiAuth = await readPiAuthCredential("opencode-go");
	if (fromPiAuth) return fromPiAuth;

	const fromEnv = process.env.OPENCODE_API_KEY?.trim();
	if (fromEnv) return fromEnv;

	const candidates = [join(getOpencodeDataDir(), "account.json")];
	if (process.platform === "darwin") {
		candidates.push(join(homedir(), "Library", "Application Support", "opencode", "account.json"));
	}
	if (process.platform === "win32") {
		const appData = process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming");
		const localAppData = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
		candidates.push(join(appData, "opencode", "account.json"), join(localAppData, "opencode", "account.json"));
	}

	for (const path of [...new Set(candidates)]) {
		if (!existsSync(path)) continue;
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as {
				accounts?: Record<string, { serviceID?: string; credential?: { type?: string; key?: string; access?: string } }>;
			};
			for (const account of Object.values(parsed.accounts ?? {})) {
				if (account.serviceID !== "opencode-go") continue;
				const credential = account.credential;
				if (!credential) continue;
				if (credential.type === "api" && credential.key?.trim()) return credential.key.trim();
				if (credential.access?.trim()) return credential.access.trim();
			}
		} catch {
			continue;
		}
	}
	return undefined;
}

async function resolveOpenCodeGoScrapeConfig(): Promise<
	{ ok: true; config: OpenCodeGoScrapeConfig; source: string } | { ok: false; error: string }
> {
	const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
	const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
	if (workspaceId || authCookie) {
		if (workspaceId && authCookie) {
			return { ok: true, config: { workspaceId, authCookie }, source: "env" };
		}
		return {
			ok: false,
			error: workspaceId
				? "Missing OPENCODE_GO_AUTH_COOKIE"
				: "Missing OPENCODE_GO_WORKSPACE_ID",
		};
	}

	for (const dir of getOpencodeConfigDirs()) {
		const path = join(dir, "opencode-quota", "opencode-go.json");
		if (!existsSync(path)) continue;
		try {
			const raw = await readFile(path, "utf8");
			const parsed = JSON.parse(raw) as { workspaceId?: string; authCookie?: string };
			const fileWorkspaceId = typeof parsed.workspaceId === "string" ? parsed.workspaceId.trim() : "";
			const fileAuthCookie = typeof parsed.authCookie === "string" ? parsed.authCookie.trim() : "";
			if (fileWorkspaceId && fileAuthCookie) {
				return { ok: true, config: { workspaceId: fileWorkspaceId, authCookie: fileAuthCookie }, source: path };
			}
			return {
				ok: false,
				error: !fileWorkspaceId
					? `Missing workspaceId in ${path}`
					: `Missing authCookie in ${path}`,
			};
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	return {
		ok: false,
		error: "No OpenCode Go scrape config (OPENCODE_GO_* or opencode-go.json)",
	};
}

function parseMonthlyUsageFromHtml(html: string): { usagePercent: number; resetInSec: number } | null {
	const pctFirstMatch = RE_MONTHLY_PCT_FIRST.exec(html);
	if (pctFirstMatch) {
		const usagePercent = Number(pctFirstMatch[1]);
		const resetInSec = Number(pctFirstMatch[2]);
		if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
			return { usagePercent, resetInSec };
		}
	}
	const resetFirstMatch = RE_MONTHLY_RESET_FIRST.exec(html);
	if (resetFirstMatch) {
		const resetInSec = Number(resetFirstMatch[1]);
		const usagePercent = Number(resetFirstMatch[2]);
		if (Number.isFinite(usagePercent) && Number.isFinite(resetInSec)) {
			return { usagePercent, resetInSec };
		}
	}
	return null;
}

function readNumericField(obj: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function parseOpenCodeGoApiPayload(payload: unknown): OpenCodeGoUsage | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const root = payload as Record<string, unknown>;
	const data =
		root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;

	const monthly =
		data.monthlyUsage && typeof data.monthlyUsage === "object"
			? (data.monthlyUsage as Record<string, unknown>)
			: data;

	const usagePercent = readNumericField(monthly, [
		"usagePercent",
		"monthlyUsagePercent",
		"percentUsed",
		"usage_percent",
	]);
	if (usagePercent == null) return undefined;

	const resetInSec = readNumericField(monthly, ["resetInSec", "reset_in_sec", "resetSeconds"]);
	const weeklyUsagePercent = readNumericField(data, ["weeklyUsagePercent", "weeklyPercentUsed"]);
	const fiveHourUsagePercent = readNumericField(data, ["fiveHourUsagePercent", "fiveHourPercentUsed"]);
	const plan = typeof data.plan === "string" ? data.plan : undefined;

	return {
		usagePercent: Math.max(0, usagePercent),
		percentRemaining: Math.max(0, 100 - usagePercent),
		resetInSec,
		resetTimeIso:
			resetInSec != null ? new Date(Date.now() + resetInSec * 1000).toISOString() : undefined,
		weeklyUsagePercent,
		fiveHourUsagePercent,
		plan,
		source: "api",
	};
}

async function fetchOpenCodeGoUsageApi(token: string): Promise<OpenCodeGoUsage> {
	const res = await fetch(OPENCODE_GO_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
		signal: AbortSignal.timeout(20_000),
	});
	const contentType = res.headers.get("content-type") ?? "";
	if (!res.ok) {
		throw new Error(`OpenCode Go API returned ${res.status}`);
	}
	if (!contentType.includes("json")) {
		throw new Error("OpenCode Go API returned non-JSON response");
	}
	const payload = await res.json();
	const parsed = parseOpenCodeGoApiPayload(payload);
	if (!parsed) throw new Error("unexpected OpenCode Go API response");
	return parsed;
}

async function fetchOpenCodeGoUsageScrape(config: OpenCodeGoScrapeConfig): Promise<OpenCodeGoUsage> {
	const url = `${OPENCODE_GO_DASHBOARD_URL_PREFIX}${encodeURIComponent(config.workspaceId)}${OPENCODE_GO_DASHBOARD_URL_SUFFIX}`;
	const res = await fetch(url, {
		headers: {
			"User-Agent": OPENCODE_GO_USER_AGENT,
			Accept: "text/html",
			Cookie: `auth=${config.authCookie}`,
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!res.ok) {
		throw new Error(`OpenCode Go dashboard returned ${res.status}`);
	}
	const html = await res.text();
	const monthly = parseMonthlyUsageFromHtml(html);
	if (!monthly) {
		throw new Error("Could not parse monthly usage from OpenCode Go dashboard");
	}
	const usagePercent = Math.max(0, monthly.usagePercent);
	const resetInSec = Math.max(0, monthly.resetInSec);
	return {
		usagePercent,
		percentRemaining: 100 - usagePercent,
		resetInSec,
		resetTimeIso: new Date(Date.now() + resetInSec * 1000).toISOString(),
		source: "scrape",
	};
}

async function fetchOpenCodeGoUsage(): Promise<OpenCodeGoUsage> {
	const scrapeConfig = await resolveOpenCodeGoScrapeConfig();
	if (scrapeConfig.ok) {
		return fetchOpenCodeGoUsageScrape(scrapeConfig.config);
	}

	const token = await readOpenCodeGoBearerToken();
	if (token) {
		try {
			return await fetchOpenCodeGoUsageApi(token);
		} catch (apiErr) {
			throw apiErr instanceof Error ? apiErr : new Error(String(apiErr));
		}
	}

	throw new NoAuthError(scrapeConfig.error);
}

function formatOpenCodeGoStatus(usage: OpenCodeGoUsage): string {
	const parts = [`OpenCode Go ${formatPct(usage.usagePercent)}%`];
	if (usage.weeklyUsagePercent != null) parts.push(`W:${formatPct(usage.weeklyUsagePercent)}%`);
	if (usage.fiveHourUsagePercent != null) parts.push(`5h:${formatPct(usage.fiveHourUsagePercent)}%`);
	return parts.join(" ");
}

function openCodeGoDetailLines(usage: OpenCodeGoUsage): string[] {
	const lines = ["OpenCode Go Usage", ""];
	if (usage.plan) lines.push(`Plan: ${usage.plan}`);
	lines.push(`Monthly used: ${formatPct(usage.usagePercent)}%`);
	lines.push(`Remaining: ${formatPct(usage.percentRemaining)}%`);
	if (usage.weeklyUsagePercent != null) {
		lines.push(`Weekly used: ${formatPct(usage.weeklyUsagePercent)}%`);
	}
	if (usage.fiveHourUsagePercent != null) {
		lines.push(`5-hour used: ${formatPct(usage.fiveHourUsagePercent)}%`);
	}
	if (usage.resetTimeIso) {
		lines.push(`Resets at: ${new Date(usage.resetTimeIso).toLocaleString()}`);
	} else if (usage.resetInSec != null) {
		lines.push(`Resets in: ${Math.ceil(usage.resetInSec / 3600)}h`);
	}
	lines.push(`Source: ${usage.source === "api" ? "API" : "dashboard scrape"}`);
	return lines;
}

async function loadCursor(): Promise<LoadResult<CursorUsage>> {
	try {
		return { ok: true, data: await fetchCursorUsage() };
	} catch (err) {
		if (err instanceof NoAuthError) {
			return { ok: false, error: "No Cursor auth (state.vscdb token or CURSOR_SESSION_TOKEN)" };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function resolveGlmApiKey(): Promise<string | undefined> {
	const fromEnv = process.env.GLM_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	return (await readPiAuthCredential("zai")) ?? (await readPiAuthCredential("glm"));
}

async function loadGlm(): Promise<LoadResult<GlmQuotaData>> {
	const apiKey = await resolveGlmApiKey();
	if (!apiKey) return { ok: false, error: "No GLM auth (GLM_API_KEY or zai key in ~/.pi/agent/auth.json)" };
	try {
		return { ok: true, data: await fetchGlmQuota(apiKey) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function loadOpenCodeGo(): Promise<LoadResult<OpenCodeGoUsage>> {
	try {
		return { ok: true, data: await fetchOpenCodeGoUsage() };
	} catch (err) {
		if (err instanceof NoAuthError) {
			return { ok: false, error: err.message };
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

async function loadAllUsage(): Promise<UsageCache> {
	const [cursor, glm, opencodeGo] = await Promise.all([loadCursor(), loadGlm(), loadOpenCodeGo()]);
	return { cursor, glm, opencodeGo };
}

function updateFooterStatuses(ctx: ExtensionContext, cache: UsageCache): void {
	if (cache.cursor.ok) {
		setStatus(ctx, CURSOR_STATUS_KEY, formatCursorStatus(cache.cursor.data));
	} else if (isProviderError(cache.cursor) && cache.cursor.error.includes("No Cursor auth")) {
		setStatus(ctx, CURSOR_STATUS_KEY, "Cursor: no auth");
	} else {
		setStatus(ctx, CURSOR_STATUS_KEY, "Cursor: error");
	}

	if (cache.glm.ok) {
		setStatus(ctx, GLM_STATUS_KEY, formatGlmStatus(cache.glm.data));
	} else if (isProviderError(cache.glm) && cache.glm.error.includes("No GLM auth")) {
		setStatus(ctx, GLM_STATUS_KEY, "GLM: no key");
	} else {
		setStatus(ctx, GLM_STATUS_KEY, "GLM: error");
	}

	if (cache.opencodeGo.ok) {
		setStatus(ctx, OPENCODE_GO_STATUS_KEY, formatOpenCodeGoStatus(cache.opencodeGo.data));
	} else if (
		isProviderError(cache.opencodeGo) &&
		(cache.opencodeGo.error.includes("No OpenCode Go") ||
			cache.opencodeGo.error.includes("Missing") ||
			cache.opencodeGo.error.includes("scrape config"))
	) {
		setStatus(ctx, OPENCODE_GO_STATUS_KEY, "OpenCode Go: no auth");
	} else {
		setStatus(ctx, OPENCODE_GO_STATUS_KEY, "OpenCode Go: error");
	}
}

function nextSection(section: UsageSection): UsageSection {
	const index = usageSections.indexOf(section);
	return usageSections[(index + 1) % usageSections.length] ?? "cursor";
}

function previousSection(section: UsageSection): UsageSection {
	const index = usageSections.indexOf(section);
	return usageSections[(index - 1 + usageSections.length) % usageSections.length] ?? "cursor";
}

function formatSectionTabs(activeSection: UsageSection, theme: ExtensionContext["ui"]["theme"]): string {
	const rendered = usageSections.map((section) => {
		const label = sectionLabels[section];
		return section === activeSection ? theme.bold(label) : safeThemeFg(theme, "muted", label);
	});
	return `  ${rendered.join(safeThemeFg(theme, "muted", " / "))}`;
}

function needsSetup(section: UsageSection, cache: UsageCache): boolean {
	switch (section) {
		case "cursor":
			return isProviderError(cache.cursor) && cache.cursor.error.includes("No Cursor auth");
		case "glm":
			return isProviderError(cache.glm) && cache.glm.error.includes("No GLM auth");
		case "opencode-go":
			return (
				isProviderError(cache.opencodeGo) &&
				(cache.opencodeGo.error.includes("No OpenCode Go") ||
					cache.opencodeGo.error.includes("Missing") ||
					cache.opencodeGo.error.includes("OpenCode Go API returned 404"))
			);
	}
}

function setupHintLines(section: UsageSection): string[] {
	switch (section) {
		case "cursor":
			return [
				"",
				"Setup: press s or run /usage-setup cursor",
				"Uses Cursor desktop token, pi /login cursor, or a session token.",
			];
		case "glm":
			return [
				"",
				"Setup: press s or run /usage-setup glm",
				"Needs a Z.ai / GLM Coding Plan API key (saved to ~/.pi/agent/auth.json).",
			];
		case "opencode-go":
			return [
				"",
				"Setup: press s or run /usage-setup opencode-go",
				"Needs workspace ID + opencode.ai auth cookie for dashboard quota.",
				"Optional: opencode-go API key in ~/.pi/agent/auth.json.",
			];
	}
}

function detailLinesForSection(section: UsageSection, cache: UsageCache): string[] {
	switch (section) {
		case "cursor": {
			if (cache.cursor.ok) return cursorDetailLines(cache.cursor.data);
			const lines = ["Cursor Usage", "", isProviderError(cache.cursor) ? cache.cursor.error : "error"];
			if (needsSetup(section, cache)) lines.push(...setupHintLines(section));
			return lines;
		}
		case "glm": {
			if (cache.glm.ok) return glmDetailLines(cache.glm.data);
			const lines = ["GLM Coding Plan Usage", "", isProviderError(cache.glm) ? cache.glm.error : "error"];
			if (needsSetup(section, cache)) lines.push(...setupHintLines(section));
			return lines;
		}
		case "opencode-go": {
			if (cache.opencodeGo.ok) return openCodeGoDetailLines(cache.opencodeGo.data);
			const lines = [
				"OpenCode Go Usage",
				"",
				isProviderError(cache.opencodeGo) ? cache.opencodeGo.error : "error",
			];
			if (needsSetup(section, cache)) lines.push(...setupHintLines(section));
			return lines;
		}
	}
}

function normalizeSetupSection(value: string | undefined): UsageSection | "all" | undefined {
	const trimmed = value?.trim().toLowerCase();
	if (!trimmed || trimmed === "all") return trimmed ? "all" : undefined;
	if (trimmed === "cursor" || trimmed === "glm" || trimmed === "opencode-go" || trimmed === "opencode") {
		return trimmed === "opencode" ? "opencode-go" : (trimmed as UsageSection);
	}
	return undefined;
}

async function setupCursorAuth(ctx: ExtensionContext): Promise<boolean> {
	if (await hasCursorAuth()) {
		ctx.ui.notify("Cursor auth already configured", "info");
		return true;
	}

	const choice = await ctx.ui.select("Cursor setup", [
		"Enter WorkosCursorSessionToken",
		"Skip for now",
	]);
	if (choice !== "Enter WorkosCursorSessionToken") return false;

	const token = (
		await ctx.ui.input(
			"Cursor session token",
			"Cookie value for WorkosCursorSessionToken from cursor.com",
		)
	)?.trim();
	if (!token) {
		ctx.ui.notify("Cursor setup cancelled", "warning");
		return false;
	}

	const path = await writeUsageExtensionConfig({ cursorSessionToken: token });
	process.env.CURSOR_SESSION_TOKEN = token;
	ctx.ui.notify(`Saved Cursor session token to ${path}`, "info");
	return true;
}

async function setupGlmAuth(ctx: ExtensionContext): Promise<boolean> {
	if (await resolveGlmApiKey()) {
		ctx.ui.notify("GLM auth already configured", "info");
		return true;
	}

	const apiKey = (await ctx.ui.input("GLM / Z.ai API key", "From open.bigmodel.cn user center"))?.trim();
	if (!apiKey) {
		ctx.ui.notify("GLM setup cancelled", "warning");
		return false;
	}

	const path = await writePiAuthCredential("zai", { type: "api_key", key: apiKey });
	ctx.ui.notify(`Saved GLM key to ${path}`, "info");
	return true;
}

async function setupOpenCodeGoAuth(ctx: ExtensionContext): Promise<boolean> {
	const scrapeConfig = await resolveOpenCodeGoScrapeConfig();
	const hasApiKey = Boolean(await readOpenCodeGoBearerToken());
	if (scrapeConfig.ok && hasApiKey) {
		ctx.ui.notify("OpenCode Go auth already configured", "info");
		return true;
	}

	ctx.ui.notify(
		"OpenCode Go billing quota uses the web dashboard (no public usage API yet).",
		"info",
	);

	let workspaceId = scrapeConfig.ok ? scrapeConfig.config.workspaceId : undefined;
	let authCookie = scrapeConfig.ok ? scrapeConfig.config.authCookie : undefined;

	if (!workspaceId) {
		workspaceId = (
			await ctx.ui.input(
				"OpenCode Go workspace ID",
				"From https://opencode.ai/workspace/<workspaceId>/go",
			)
		)?.trim();
	}
	if (!workspaceId) {
		ctx.ui.notify("OpenCode Go setup cancelled", "warning");
		return false;
	}

	if (!authCookie) {
		authCookie = (
			await ctx.ui.input(
				"OpenCode Go auth cookie",
				"DevTools → Application → Cookies → opencode.ai → auth",
			)
		)?.trim();
	}
	if (!authCookie) {
		ctx.ui.notify("OpenCode Go setup cancelled", "warning");
		return false;
	}

	const scrapePath = await writeOpenCodeGoScrapeFile({ workspaceId, authCookie });
	ctx.ui.notify(`Saved OpenCode Go dashboard auth to ${scrapePath}`, "info");

	if (!hasApiKey) {
		const saveApiKey = await ctx.ui.confirm(
			"OpenCode Go API key",
			"Also save an opencode-go API key to ~/.pi/agent/auth.json?",
		);
		if (saveApiKey) {
			const apiKey = (await ctx.ui.input("OpenCode Go API key", "sk-..."))?.trim();
			if (apiKey) {
				const authPath = await writePiAuthCredential("opencode-go", { type: "api_key", key: apiKey });
				ctx.ui.notify(`Saved OpenCode Go API key to ${authPath}`, "info");
			}
		}
	}

	return true;
}

async function setupUsageProvider(ctx: ExtensionContext, section: UsageSection): Promise<boolean> {
	switch (section) {
		case "cursor":
			return setupCursorAuth(ctx);
		case "glm":
			return setupGlmAuth(ctx);
		case "opencode-go":
			return setupOpenCodeGoAuth(ctx);
	}
}

async function setupUsageProviders(
	ctx: ExtensionContext,
	target: UsageSection | "all" = "all",
): Promise<void> {
	if (!ctx.hasUI) {
		console.log("Usage setup requires the pi TUI. Run /usage-setup in interactive mode.");
		return;
	}

	const sections = target === "all" ? usageSections : [target];
	for (const section of sections) {
		await setupUsageProvider(ctx, section);
	}
}

export default function (pi: ExtensionAPI) {
	let timer: Timer | undefined;
	let fetching = false;
	let pendingRefresh = false;
	let activeCtx: ExtensionContext | undefined;

	function clearRefreshTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	async function refreshStatus(ctx: ExtensionContext): Promise<void> {
		if (fetching) {
			pendingRefresh = true;
			return;
		}
		fetching = true;
		try {
			const cache = await loadAllUsage();
			updateFooterStatuses(ctx, cache);
		} finally {
			fetching = false;
			if (pendingRefresh) {
				pendingRefresh = false;
				void refreshStatus(ctx);
			}
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		clearRefreshTimer();
		activeCtx = ctx;
		await refreshStatus(ctx);
		if (ctx.hasUI) {
			timer = setInterval(() => {
				if (activeCtx) void refreshStatus(activeCtx);
			}, REFRESH_MS);
			(timer as { unref?: () => void }).unref?.();
		}
	});

	pi.on("session_shutdown", () => {
		clearRefreshTimer();
		if (activeCtx) {
			setStatus(activeCtx, CURSOR_STATUS_KEY, undefined);
			setStatus(activeCtx, GLM_STATUS_KEY, undefined);
			setStatus(activeCtx, OPENCODE_GO_STATUS_KEY, undefined);
		}
		activeCtx = undefined;
	});

	pi.registerCommand("usage-setup", {
		description: "Configure auth for Cursor, GLM, or OpenCode Go usage tracking",
		handler: async (args, ctx) => {
			const normalized = normalizeSetupSection(args);
			if (args.trim() && normalized === undefined) {
				ctx.ui.notify("Usage: /usage-setup [cursor|glm|opencode-go|all]", "warning");
				return;
			}
			await setupUsageProviders(ctx, normalized ?? "all");
			if (activeCtx) await refreshStatus(activeCtx);
		},
	});

	pi.registerCommand("usage", {
		description: "Show usage across Cursor, GLM, and OpenCode Go",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				const cache = await loadAllUsage();
				console.log(JSON.stringify(cache, null, 2));
				return;
			}

			const mode = (ctx as typeof ctx & { mode?: string }).mode;
			if (mode !== undefined && mode !== "tui") return;

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				let activeSection: UsageSection = "cursor";
				let cache: UsageCache = {
					cursor: { ok: false, error: "Loading…" },
					glm: { ok: false, error: "Loading…" },
					opencodeGo: { ok: false, error: "Loading…" },
				};
				let loading = true;

				const refresh = async () => {
					loading = true;
					tui.requestRender();
					cache = await loadAllUsage();
					loading = false;
					updateFooterStatuses(ctx, cache);
					tui.requestRender();
				};

				void refresh();

				const switchSection = (direction: "forward" | "backward") => {
					activeSection =
						direction === "forward" ? nextSection(activeSection) : previousSection(activeSection);
					tui.requestRender();
				};

				const runSetup = async () => {
					await setupUsageProvider(ctx, activeSection);
					await refresh();
				};

				return {
					render(width: number) {
						const border = "─".repeat(Math.max(0, width));
						const lines = loading
							? ["Loading usage…"]
							: detailLinesForSection(activeSection, cache);
						const footer = safeThemeFg(
							theme,
							"muted",
							"  Tab/Shift+Tab switch · s setup · r refresh · Esc close",
						);
						return [
							truncateToWidth(border, width, ""),
							truncateToWidth(formatSectionTabs(activeSection, theme), width, ""),
							truncateToWidth(border, width, ""),
							...lines.map((line) => truncateToWidth(line, width, "")),
							truncateToWidth(footer, width, ""),
							truncateToWidth(border, width, ""),
						];
					},
					handleInput(data: string) {
						if (matchesKey(data, Key.tab)) {
							switchSection("forward");
							return;
						}
						if (matchesKey(data, Key.shift("tab"))) {
							switchSection("backward");
							return;
						}
						if (matchesKey(data, Key.escape)) {
							done(undefined);
							return;
						}
						if (matchesKey(data, Key.ctrl("r")) || data === "r") {
							void refresh();
							return;
						}
						if (data === "s" || data === "S") {
							void runSetup();
						}
					},
				};
			});
		},
	});
}
