import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	displayText,
	epochSeconds,
	formatClock,
	isRecord,
	numberValue,
	stringValue,
	ProviderStateError,
	type AdapterContext,
	type ProviderAdapter,
	type ProviderSnapshot,
	type UsageRow,
	type UsageWindow,
} from "../core.ts";
import { fetchBoundedJson, fetchStatus, HttpError } from "../network.ts";
import { parseOpencodeGoPayload } from "./opencode-go.ts";

const PROVIDER_ID = "cliproxyapi";
const LABEL = "CLIProxyAPI";
const HEALTH_TIMEOUT_MS = 1_500;
export const BASE_URL_ENV = "PI_USAGE_CPA_BASE_URL";
export const MANAGEMENT_KEY_ENV = "PI_USAGE_CPA_MANAGEMENT_KEY";
const HASHED_SECRET = /^\$(2[aby]|argon2)/;
const BAN_BODY = /IP banned due to too many failed attempts/i;
const HANDSHAKE_PATHS = ["/v0/management/config", "/v8/management/credentials"];
const CREDENTIAL_PATHS = ["/v0/management/auth-files", "/v8/management/credentials"];
const TRAFFIC_PATHS = ["/v0/management/api-key-usage", "/v8/management/observability/usage/api-keys"];
/** Token refresh for stale credential files; one call per snapshot, `{all: true}` covers every stale file. */
const REFRESH_PATHS = ["/v0/management/auth-files/refresh", "/v8/management/credentials/refresh"];
/** A token expiring within this window is refreshed before the provider is called. */
const TOKEN_REFRESH_GRACE_MS = 2 * 60_000;
const CREDENTIAL_DIR = ".cli-proxy-api";
// CLIProxyAPI v8 registers no quota routes; only v0 serves them.
const QUOTA_PROVIDER_PATHS = ["/v0/management/quota/providers"];
const QUOTA_FETCH_PATHS = ["/v0/management/quota/fetch"];
const QUOTA_FETCH_CONCURRENCY = 4;
// Antigravity quota RPC: experimental and undocumented; verified against a live response.
const ANTIGRAVITY_DAILY_BASE = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_FALLBACK_BASE = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_QUOTA_PATH = "/v1internal:retrieveUserQuotaSummary";
/** Mirrors the Antigravity CLI client so the RPC answers the same way it answers the CLI. */
const ANTIGRAVITY_USER_AGENT = "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";
// The OpenCode usage endpoint sits behind a Cloudflare bot gate; these client fingerprint headers are required.
const OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_USER_AGENT = "opencode/latest/2.0.18/cli";
const SESSION_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MANAGEMENT_OFF = "Management API is off · set remote-management.secret-key in the CLIProxyAPI config";

type KeyCandidate = { source: string; key: string };
type SessionKey = KeyCandidate & { notes: string[] };

/** Accepted management key per proxy origin, kept for the Pi session. */
const verifiedKeys = new Map<string, KeyCandidate>();
/** Keys the proxy answered 401 to, per origin. Each value is tried at most once per session: 5 failures ban the IP for 30 minutes. */
const rejectedKeys = new Map<string, Set<string>>();

export function resetManagementKeyCache(): void {
	verifiedKeys.clear();
	rejectedKeys.clear();
}

function rejectedFor(origin: string): Set<string> {
	const rejected = rejectedKeys.get(origin) ?? new Set<string>();
	rejectedKeys.set(origin, rejected);
	return rejected;
}

function readJsonFile(path: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readTextFile(path: string): string | undefined {
	try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function providerConfig(ctx: AdapterContext): Record<string, unknown> {
	return readJsonFile(join(ctx.agentDir, "pi-cliproxyapi-provider", "config.json"));
}

/** Proxy origin from the env override or the pi-cliproxyapi-provider `baseUrl`. */
export function resolveOrigin(ctx: AdapterContext): string | undefined {
	const configured = stringValue(ctx.env[BASE_URL_ENV]) ?? stringValue(providerConfig(ctx).baseUrl);
	if (!configured) return undefined;
	try {
		const url = new URL(configured);
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

/** The single `secret-key:` line of CLIProxyAPI's config.yaml, unquoted; no YAML parser. */
export function parseSecretKeyLine(yaml: string): string | undefined {
	for (const line of yaml.split(/\r?\n/)) {
		const match = /^\s*secret-key:\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = (match[1] ?? "").trim();
		const quoted = /^(["'])(.*)\1/.exec(value);
		if (quoted) value = quoted[2] ?? "";
		else value = value.replace(/\s+#.*$/, "").trim();
		return value || undefined;
	}
	return undefined;
}

/** Candidates in discovery order: explicit, tool-written, then heuristic. Hashed config values are never candidates. */
export function managementKeyCandidates(ctx: AdapterContext): { candidates: KeyCandidate[]; notes: string[] } {
	const notes: string[] = [];
	const found: KeyCandidate[] = [];
	const add = (source: string, key: string | undefined) => {
		const trimmed = key?.trim();
		if (trimmed && !found.some((candidate) => candidate.key === trimmed)) found.push({ source, key: trimmed });
	};
	add(MANAGEMENT_KEY_ENV, stringValue(ctx.env[MANAGEMENT_KEY_ENV]));
	add("pi-cliproxyapi-provider/config.json managementKey", stringValue(providerConfig(ctx).managementKey));
	add("~/.cli-proxy-api/.management-password", readTextFile(join(ctx.homeDir, ".cli-proxy-api", ".management-password"))?.split(/\r?\n/)[0]);
	const yaml = readTextFile(join(ctx.homeDir, ".cli-proxy-api", "config.yaml"));
	const secretKey = yaml === undefined ? undefined : parseSecretKeyLine(yaml);
	if (secretKey && HASHED_SECRET.test(secretKey)) notes.push("Skipped the hashed secret-key in ~/.cli-proxy-api/config.yaml.");
	else add("~/.cli-proxy-api/config.yaml secret-key", secretKey);
	return { candidates: found, notes };
}

function retryDuration(body: string): string | undefined {
	const match = /try again in\s+([0-9][0-9hms.]*)/i.exec(body);
	return match?.[1]?.replace(/(\d+)\.\d+s/, "$1s");
}

/** IP bans and rate limits apply to every candidate equally; they are never "bad key" results. */
export function blockedState(error: unknown): ProviderStateError | undefined {
	if (!(error instanceof HttpError)) return undefined;
	const duration = retryDuration(error.body);
	if (error.status === 403 && BAN_BODY.test(error.body)) {
		return new ProviderStateError("blocked", duration ? `Proxy banned this host's IP · retry in ${duration}` : "Proxy temporarily banned this host's IP");
	}
	if (error.status === 429) {
		return new ProviderStateError("blocked", duration ? `Proxy is rate limiting this host · retry in ${duration}` : "Proxy is rate limiting this host · retry later");
	}
	return undefined;
}

async function managementRequest(
	ctx: AdapterContext, origin: string, paths: readonly string[], key: string,
	init: { method?: string; body?: unknown }, signal?: AbortSignal,
): Promise<unknown> {
	for (const [index, path] of paths.entries()) {
		try {
			return await fetchBoundedJson(`${origin}${path}`, {
				method: init.method ?? "GET",
				headers: {
					accept: "application/json",
					"X-Management-Key": key,
					...(init.body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
				signal,
			}, { fetch: ctx.fetch, label: LABEL });
		} catch (error) {
			// Older/newer proxies expose the same route under another API version.
			if (error instanceof HttpError && error.status === 404 && index < paths.length - 1) continue;
			throw error;
		}
	}
	throw new Error(`${LABEL} management route unavailable.`);
}

/** Every management route answers 404 when the proxy has no management secret configured. */
function managementOff(error: unknown): boolean {
	return error instanceof HttpError && error.status === 404;
}

/**
 * Tries at most one not-yet-rejected candidate per call, so a refresh adds at most one failed
 * attempt to CLIProxyAPI's ban counter. A ban or other failure stops without rejecting the key.
 */
export async function verifiedManagementKey(ctx: AdapterContext, origin: string, signal?: AbortSignal): Promise<SessionKey> {
	const { candidates, notes } = managementKeyCandidates(ctx);
	const cached = verifiedKeys.get(origin);
	if (cached) return { ...cached, notes };
	if (!candidates.length) {
		throw new ProviderStateError("setup", `No management key · set ${MANAGEMENT_KEY_ENV}${notes.length ? " (config.yaml secret-key is hashed)" : ""}`);
	}
	const rejected = rejectedFor(origin);
	const noneVerified = () => {
		const count = candidates.filter((entry) => rejected.has(entry.key)).length;
		return new ProviderStateError("setup", `No verified management key · ${count} candidate${count === 1 ? "" : "s"} rejected`);
	};
	const candidate = candidates.find((entry) => !rejected.has(entry.key));
	if (!candidate) throw noneVerified();
	try {
		await managementRequest(ctx, origin, HANDSHAKE_PATHS, candidate.key, {}, signal);
	} catch (error) {
		const blocked = blockedState(error);
		if (blocked) throw blocked;
		if (managementOff(error)) throw new ProviderStateError("setup", MANAGEMENT_OFF);
		if (!(error instanceof HttpError) || error.status !== 401) throw error;
		rejected.add(candidate.key);
		if (candidates.every((entry) => rejected.has(entry.key))) throw noneVerified();
		throw new ProviderStateError("setup", `Management key from ${candidate.source} rejected · retry to try the next candidate`);
	}
	verifiedKeys.set(origin, candidate);
	return { ...candidate, notes };
}

export type CpaCredential = {
	authIndex?: string | number;
	provider: string;
	account: string;
	disabled: boolean;
	unavailable: boolean;
	/** Legacy pre-v8 `quota.exceeded`; v8 never sends it. */
	exceeded: boolean;
	/** Scheduler status other than `active`, e.g. `error`, `pending`, `refreshing`. */
	status?: string;
	reason?: string;
	recoverAt?: number;
	failed?: number;
	priority?: number;
	/** Plain `<name>.json` file in `~/.cli-proxy-api` holding the upstream token; internal, never rendered. */
	fileName?: string;
};

const QUIET_STATUSES = new Set(["active", "disabled"]);

function integerLike(value: unknown): number | undefined {
	const number = typeof value === "string" && value.trim() ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

/** Plain `<name>.json` basename for reading the credential file: no separators, no control characters, no key material. */
function credentialFileName(value: unknown, apiKey: string | undefined): string | undefined {
	const name = stringValue(value);
	if (!name || name.length > 200 || !/^[^\\/\u0000-\u001f]+\.json$/i.test(name)) return undefined;
	if (apiKey && (name.includes(apiKey) || apiKey.includes(name))) return undefined;
	return name;
}

/**
 * and `failed`; its `quota` object holds only `observed_at` and `signals`. The `quota.exceeded`,
 * `quota.reason` and `quota.next_recover_at` reads are a fallback for older proxies.
 */
export function parseCredentials(payload: unknown): CpaCredential[] {
	const root = isRecord(payload) ? payload : {};
	const list = Array.isArray(payload) ? payload : [root.files, root.credentials, root.items, root.data].find(Array.isArray) ?? [];
	return list.filter(isRecord).map((file) => {
		const quota = isRecord(file.quota) ? file.quota : {};
		// For api_key credentials `account` is the plaintext upstream key: never display it, nor any field equal to it.
		const apiKey = file.account_type === "oauth" ? undefined : stringValue(file.account)?.trim();
		const safe = (value: unknown, maxLength?: number) => {
			const text = displayText(value, maxLength);
			return text && apiKey && (text.includes(apiKey) || stringValue(value)?.includes(apiKey)) ? undefined : text;
		};
		const name = safe(file.name)?.replace(/\.json$/i, "");
		const fileName = credentialFileName(file.name, apiKey);
		const authIndex = file.auth_index ?? file.index;
		const status = safe(file.status, 24)?.toLowerCase();
		const reason = safe(file.status_message, 60) ?? safe(quota.reason, 60);
		const recoverAt = epochSeconds(file.next_retry_after) ?? epochSeconds(quota.next_recover_at);
		const failed = integerLike(file.failed);
		return {
			...(typeof authIndex === "string" || typeof authIndex === "number" ? { authIndex } : {}),
			provider: safe(file.provider, 32) ?? safe(file.type, 32) ?? "unknown",
			account: safe(file.email) ?? (apiKey ? undefined : safe(file.account)) ?? safe(file.label) ?? name ?? safe(file.id) ?? "credential",
			disabled: file.disabled === true || status === "disabled",
			unavailable: file.unavailable === true,
			exceeded: quota.exceeded === true,
			...(status && !QUIET_STATUSES.has(status) ? { status } : {}),
			...(reason ? { reason } : {}),
			...(recoverAt !== undefined ? { recoverAt } : {}),
			...(failed !== undefined && failed > 0 ? { failed } : {}),
			...(integerLike(file.priority) !== undefined ? { priority: integerLike(file.priority) } : {}),
			...(fileName ? { fileName } : {}),
		};
	}).sort((left, right) => left.provider.localeCompare(right.provider) || left.account.localeCompare(right.account));
}

export function credentialState(credential: CpaCredential, now = Date.now()): string {
	if (credential.disabled) return "disabled";
	if (credential.recoverAt !== undefined && credential.recoverAt * 1000 > now) return `cooling down until ${formatClock(credential.recoverAt, now)}`;
	if (credential.exceeded) return "exceeded";
	if (credential.unavailable) return "unavailable";
	return credential.status ?? "ok";
}

export type TrafficSummary = {
	provider: string;
	success: number;
	failed: number;
	/** Newest `recent_requests` bucket; `label` is the proxy's local-time `HH:MM-HH:MM` string, not a timestamp. */
	recent?: { label?: string; success: number; failed: number };
};

function count(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Aggregates per provider; the `<base_url>|<api_key>` map keys are dropped and never returned. */
export function parseTraffic(payload: unknown): TrafficSummary[] {
	if (!isRecord(payload)) return [];
	const summaries: TrafficSummary[] = [];
	for (const [providerKey, entries] of Object.entries(payload)) {
		const provider = displayText(providerKey, 32);
		if (!provider || !isRecord(entries)) continue;
		const summary: TrafficSummary = { provider, success: 0, failed: 0 };
		for (const stats of Object.values(entries)) {
			if (!isRecord(stats)) continue;
			summary.success += count(stats.success);
			summary.failed += count(stats.failed);
			// Buckets run oldest to newest and every key shares the same bucket window, so the last ones add up.
			const newest = Array.isArray(stats.recent_requests) ? stats.recent_requests.at(-1) : undefined;
			if (!isRecord(newest)) continue;
			const label = displayText(newest.time, 16) ?? summary.recent?.label;
			summary.recent = {
				...(label ? { label } : {}),
				success: (summary.recent?.success ?? 0) + count(newest.success),
				failed: (summary.recent?.failed ?? 0) + count(newest.failed),
			};
		}
		summaries.push(summary);
	}
	return summaries.sort((left, right) => left.provider.localeCompare(right.provider));
}

export function trafficRow(summary: TrafficSummary): UsageRow {
	const recent = summary.recent;
	const latest = recent ? ` · latest${recent.label ? ` ${recent.label}` : ""} ${recent.success}/${recent.failed}` : "";
	return { group: "Traffic", label: summary.provider, windows: [], state: `${summary.success} ok · ${summary.failed} failed${latest}` };
}

/** Provider ids served by a quota plugin; empty when none is installed. */
export function parseQuotaProviders(payload: unknown): { ids: string[]; count: number } {
	const list = isRecord(payload) && Array.isArray(payload.providers) ? payload.providers : [];
	const ids = list.map((item) => typeof item === "string" ? stringValue(item) : isRecord(item) ? stringValue(item.id ?? item.provider ?? item.name) : undefined)
		.filter((id): id is string => id !== undefined);
	return { ids, count: list.length };
}

/** Normalized plugin buckets as used percentages (`100 - remainingFraction * 100`). */
export function parseQuotaBuckets(payload: unknown): UsageWindow[] {
	const root = isRecord(payload) ? payload : {};
	const groups = Array.isArray(root.groups) ? root.groups.filter(isRecord) : [];
	return groups.flatMap((group) => {
		const groupLabel = displayText(group.displayName ?? group.display_name, 24);
		const buckets = Array.isArray(group.buckets) ? group.buckets.filter(isRecord) : [];
		return buckets.map((bucket) => {
			const fraction = numberValue(bucket.remainingFraction) ?? numberValue(bucket.remaining_fraction);
			const resetsAt = epochSeconds(bucket.resetTime ?? bucket.reset_time);
			const note = displayText(bucket.description, 40);
			return {
				label: [groupLabel, displayText(bucket.window, 16)].filter(Boolean).join(" ") || "quota",
				...(fraction !== undefined ? { usedPercent: 100 - fraction * 100 } : {}),
				...(resetsAt !== undefined ? { resetsAt } : {}),
				...(note ? { note } : {}),
			};
		});
	});
}

export type AntigravityQuotaGroup = { group: string; windows: UsageWindow[] };

/**
 * Antigravity quota groups: `groups[].displayName` becomes the section heading, each bucket a
 * window with `used = (1 - remainingFraction) * 100` kept raw (display clamps). The window label
 * comes from `window`, falling back to the bucket `displayName`, then `bucketId`. An
 * unrecognized payload degrades to one `?%` window with a short note; never a throw.
 */
export function parseAntigravityQuota(payload: unknown, fallbackGroup = "Antigravity"): AntigravityQuotaGroup[] {
	const root = isRecord(payload) ? payload : {};
	const groups = Array.isArray(root.groups) ? root.groups.filter(isRecord) : [];
	const parsed = groups.flatMap((group) => {
		const heading = displayText(group.displayName ?? group.display_name, 32) ?? fallbackGroup;
		const buckets = Array.isArray(group.buckets) ? group.buckets.filter(isRecord) : [];
		if (!buckets.length) return [];
		return [{
			group: heading,
			windows: buckets.map((bucket) => {
				const label = displayText(bucket.window, 16)
					?? displayText(bucket.displayName ?? bucket.display_name, 32)
					?? displayText(bucket.bucketId ?? bucket.bucket_id, 32)
					?? "quota";
				const fraction = numberValue(bucket.remainingFraction) ?? numberValue(bucket.remaining_fraction);
				const resetsAt = epochSeconds(bucket.resetTime ?? bucket.reset_time);
				return {
					label,
					...(fraction !== undefined ? { usedPercent: (1 - fraction) * 100 } : {}),
					...(resetsAt !== undefined ? { resetsAt } : {}),
					...(fraction === undefined ? { note: "unrecognized" } : {}),
				};
			}),
		}];
	});
	return parsed.length ? parsed : [{ group: fallbackGroup, windows: [{ label: "quota", note: "unrecognized response" }] }];
}

async function antigravityQuotaRequest(ctx: AdapterContext, baseUrl: string, accessToken: string, signal?: AbortSignal): Promise<unknown> {
	return fetchBoundedJson(`${baseUrl}${ANTIGRAVITY_QUOTA_PATH}`, {
		method: "POST",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${accessToken}`,
			"content-type": "application/json",
			"user-agent": ANTIGRAVITY_USER_AGENT,
		},
		body: "{}",
		signal,
	}, { fetch: ctx.fetch, label: "Antigravity" });
}

/** Daily sandbox first; only a network failure or a 5xx falls back to the production endpoint. */
async function fetchAntigravityQuotaGroups(ctx: AdapterContext, accessToken: string, signal?: AbortSignal): Promise<AntigravityQuotaGroup[]> {
	try {
		return parseAntigravityQuota(await antigravityQuotaRequest(ctx, ANTIGRAVITY_DAILY_BASE, accessToken, signal));
	} catch (error) {
		if (error instanceof HttpError && error.status < 500) throw error;
		return parseAntigravityQuota(await antigravityQuotaRequest(ctx, ANTIGRAVITY_FALLBACK_BASE, accessToken, signal));
	}
}

/** `ses_` + 12 hex + 14 base62; fresh per request, and never rendered or logged. */
function openCodeSessionId(): string {
	const bytes = randomBytes(20);
	const hex = bytes.subarray(0, 6).toString("hex");
	let suffix = "";
	for (const byte of bytes.subarray(6)) suffix += SESSION_ID_ALPHABET[byte % 62]!;
	return `ses_${hex}${suffix}`;
}

/** OpenCode Zen Go usage for one credential; `percent` is already a used percentage and is kept as-is. */
async function fetchOpencodeQuotaWindows(ctx: AdapterContext, apiKey: string, signal?: AbortSignal): Promise<UsageWindow[]> {
	const payload = await fetchBoundedJson(OPENCODE_USAGE_URL, {
		method: "GET",
		headers: {
			accept: "application/json",
			authorization: `Bearer ${apiKey}`,
			"user-agent": OPENCODE_USER_AGENT,
			"x-opencode-client": "cli",
			"x-opencode-session": openCodeSessionId(),
		},
		signal,
	}, { fetch: ctx.fetch, label: "OpenCode" });
	return parseOpencodeGoPayload(payload).rows[0]?.windows ?? [];
}

/** True when the antigravity `expired` time is past or within the refresh grace window. */
function tokenIsStale(file: Record<string, unknown>, now: number): boolean {
	const expiredAt = epochSeconds(file.expired);
	return expiredAt !== undefined && expiredAt * 1000 - now <= TOKEN_REFRESH_GRACE_MS;
}

export function credentialStateText(credential: CpaCredential, now = Date.now()): string {
	return [
		credentialState(credential, now),
		credential.reason,
		credential.failed !== undefined ? `${credential.failed} failed` : undefined,
		credential.priority !== undefined ? `priority ${credential.priority}` : undefined,
	].filter(Boolean).join(" · ");
}

export function credentialRow(credential: CpaCredential, windows: UsageWindow[], now = Date.now()): UsageRow {
	return { group: credential.provider, label: credential.account, windows, state: credentialStateText(credential, now) };
}

type ManagementSession = { ctx: AdapterContext; origin: string; key: SessionKey; rekeyed?: Promise<SessionKey>; signal?: AbortSignal };

/**
 * Each request retries once after a 401/403. Concurrent failures share one re-resolution per
 * snapshot; only a 401 invalidates the cached key and marks it rejected.
 */
async function sessionRequest(session: ManagementSession, paths: readonly string[], init: { method?: string; body?: unknown } = {}): Promise<unknown> {
	const used = session.key;
	try {
		return await managementRequest(session.ctx, session.origin, paths, used.key, init, session.signal);
	} catch (error) {
		const blocked = blockedState(error);
		if (blocked) throw blocked;
		if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403)) throw error;
		const status = error.status;
		session.rekeyed ??= (async () => {
			if (status === 401) {
				verifiedKeys.delete(session.origin);
				rejectedFor(session.origin).add(used.key);
			}
			session.key = await verifiedManagementKey(session.ctx, session.origin, session.signal);
			return session.key;
		})();
		const key = await session.rekeyed;
		return await managementRequest(session.ctx, session.origin, paths, key.key, init, session.signal);
	}
}

/** Runs `task` over `items` with at most `limit` in flight; the first rejection stops new work. */
async function forEachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	let stopped = false;
	const worker = async () => {
		while (!stopped && next < items.length) {
			const item = items[next++]!;
			try {
				await task(item);
			} catch (error) {
				stopped = true;
				throw error;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function fetchCliproxySnapshot(ctx: AdapterContext, signal?: AbortSignal, now = Date.now()): Promise<ProviderSnapshot> {
	const origin = resolveOrigin(ctx);
	if (!origin) throw new ProviderStateError("setup", `No proxy base URL · set ${BASE_URL_ENV}`);
	const key = await verifiedManagementKey(ctx, origin, signal);
	const notes: string[] = [];
	const session: ManagementSession = { ctx, origin, key, signal };
	let listing: unknown;
	try {
		listing = await sessionRequest(session, CREDENTIAL_PATHS);
	} catch (error) {
		if (managementOff(error)) throw new ProviderStateError("setup", MANAGEMENT_OFF);
		throw error;
	}
	const credentials = parseCredentials(listing);

	const rows: UsageRow[] = [];
	try {
		const summaries = parseTraffic(await sessionRequest(session, TRAFFIC_PATHS));
		if (summaries.length) rows.push(...summaries.map((summary) => trafficRow(summary)));
		else notes.push("No API-key traffic recorded.");
	} catch (error) {
		if (error instanceof ProviderStateError) throw error;
		notes.push("Traffic summary unavailable.");
	}

	let plugin: { ids: string[]; count: number } = { ids: [], count: 0 };
	try {
		plugin = parseQuotaProviders(await sessionRequest(session, QUOTA_PROVIDER_PATHS));
	} catch (error) {
		if (error instanceof ProviderStateError) throw error;
	}
	const windowsByCredential = new Map<CpaCredential, UsageWindow[]>();
	if (plugin.count > 0) {
		let failures = 0;
		const served = credentials.filter((credential) =>
			credential.authIndex !== undefined && (plugin.ids.length === 0 || plugin.ids.includes(credential.provider)));
		await forEachLimited(served, QUOTA_FETCH_CONCURRENCY, async (credential) => {
			try {
				const payload = await sessionRequest(session, QUOTA_FETCH_PATHS, {
					method: "POST", body: { auth_index: credential.authIndex, provider: credential.provider },
				});
				windowsByCredential.set(credential, parseQuotaBuckets(payload));
			} catch (error) {
				if (error instanceof ProviderStateError) throw error;
				failures += 1;
			}
		});
		if (failures) notes.push(`Quota plugin fetch failed for ${failures} credential${failures === 1 ? "" : "s"}.`);
	} else {
		notes.push("Normalized quota needs a CLIProxyAPI quota plugin.");
	}

	// Upstream provider quota, fetched directly from the provider APIs with the credential files in ~/.cli-proxy-api.
	const upstreamRows = new Map<CpaCredential, UsageRow[]>();
	const tokenExpired = new Set<CpaCredential>();
	const stale: CpaCredential[] = [];
	type UpstreamCredential = { credential: CpaCredential; file: Record<string, unknown>; provider: "antigravity" | "opencode-go" };
	const upstream: UpstreamCredential[] = [];
	for (const credential of credentials) {
		if (credential.disabled || !credential.fileName) continue;
		if (credential.provider !== "antigravity" && credential.provider !== "opencode-go") continue;
		const file = readJsonFile(join(ctx.homeDir, CREDENTIAL_DIR, credential.fileName));
		if (credential.provider === "antigravity") {
			if (stringValue(file.type) !== "antigravity" || !stringValue(file.access_token)) continue;
			if (tokenIsStale(file, now)) stale.push(credential);
			else upstream.push({ credential, file, provider: "antigravity" });
		} else if (stringValue(file.type) === "opencode-go" && stringValue(file.api_key)) {
			upstream.push({ credential, file, provider: "opencode-go" });
		}
	}
	if (stale.length) {
		// One refresh per snapshot covers every stale file; the re-read picks up the new tokens.
		try {
			await sessionRequest(session, REFRESH_PATHS, { method: "POST", body: { all: true } });
		} catch (error) {
			if (error instanceof ProviderStateError) throw error;
		}
		for (const credential of stale) {
			const file = readJsonFile(join(ctx.homeDir, CREDENTIAL_DIR, credential.fileName!));
			if (stringValue(file.type) === "antigravity" && stringValue(file.access_token) && !tokenIsStale(file, now)) {
				upstream.push({ credential, file, provider: "antigravity" });
			} else tokenExpired.add(credential);
		}
	}
	let upstreamFailures = 0;
	await forEachLimited(upstream, QUOTA_FETCH_CONCURRENCY, async (task) => {
		try {
			if (task.provider === "antigravity") {
				const groups = await fetchAntigravityQuotaGroups(ctx, stringValue(task.file.access_token)!, signal);
				const state = credentialStateText(task.credential, now);
				upstreamRows.set(task.credential, groups.map((group, index) => ({
					group: group.group,
					label: task.credential.account,
					windows: group.windows,
					...(index === 0 ? { state } : {}),
				})));
			} else {
				const windows = await fetchOpencodeQuotaWindows(ctx, stringValue(task.file.api_key)!, signal);
				upstreamRows.set(task.credential, [credentialRow(task.credential, windows, now)]);
			}
		} catch (error) {
			if (error instanceof ProviderStateError) throw error;
			upstreamFailures += 1;
		}
	});
	if (upstreamFailures) notes.push(`Upstream quota failed for ${upstreamFailures} credential${upstreamFailures === 1 ? "" : "s"}.`);

	rows.push(...credentials.flatMap((credential) => {
		const upstream = upstreamRows.get(credential);
		if (upstream?.length) return upstream;
		if (tokenExpired.has(credential)) return [{ group: credential.provider, label: credential.account, windows: [], state: "token expired" }];
		return [credentialRow(credential, windowsByCredential.get(credential) ?? [], now)];
	}));
	if (!credentials.length) notes.push("No credentials reported by the proxy.");
	const observedAt = isRecord(listing) ? epochSeconds(listing.observed_at) : undefined;
	return {
		providerId: PROVIDER_ID,
		title: LABEL,
		subtitle: new URL(origin).host,
		rows,
		// The key may have been re-resolved mid-fetch; report the one that served the data.
		notes: [...session.key.notes, `Management key from ${session.key.source}.`, ...notes],
		observedAt: observedAt ?? Math.floor(now / 1000),
	};
}

export const cliproxyapiAdapter: ProviderAdapter = {
	id: PROVIDER_ID,
	title: LABEL,
	async hasCredentials(ctx) {
		const origin = resolveOrigin(ctx);
		return origin !== undefined && await fetchStatus(`${origin}/healthz`, ctx.fetch, HEALTH_TIMEOUT_MS) === 200;
	},
	fetch: (ctx, signal) => fetchCliproxySnapshot(ctx, signal),
};
