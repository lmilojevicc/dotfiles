import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { formatClock, ProviderStateError } from "../core.ts";
import {
	cliproxyapiAdapter,
	credentialRow,
	fetchCliproxySnapshot,
	managementKeyCandidates,
	parseAntigravityQuota,
	parseCredentials,
	parseQuotaBuckets,
	parseSecretKeyLine,
	parseTraffic,
	resetManagementKeyCache,
	resolveOrigin,
} from "../providers/cliproxyapi.ts";
import { formatProviderLines } from "../render.ts";
import { adapterContext, fakeFetch, jsonResponse, plain, tempDir, theme, widths, type RecordedRequest } from "./helpers.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const ORIGIN = "http://127.0.0.1:8317";
const HASH = "$2a$10$SECRETHASHabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRS";
const GOOD = "pw-SECRET-good-key";
const STALE = "mk-SECRET-stale-key";
const ENV_KEY = "env-SECRET-key";
/** CLIProxyAPI sets `account` to the plaintext upstream key for api_key credentials. */
const API_KEY_ACCOUNT = "sk-SECRET-account-value";
const SECRETS = [HASH, GOOD, STALE, ENV_KEY, API_KEY_ACCOUNT, "sk-SECRET"];

/** `recent_requests` buckets run oldest to newest; `time` is a local-time "HH:MM-HH:MM" label. */
const recent = (newest: { success: number; failed: number }) => [
	{ time: "11:45-11:50", success: 3, failed: 0 },
	{ time: "11:50-11:55", success: 0, failed: 0 },
	{ time: "11:55-12:00", ...newest },
];

/** A v8 auth-files entry: state lives in status/status_message/unavailable/next_retry_after; quota has only observed_at + signals. */
function authFile(fields: Record<string, unknown>): Record<string, unknown> {
	return {
		label: "", status: "active", status_message: "", disabled: false, unavailable: false, runtime_only: false,
		source: "file", size: 512, success: 0, failed: 0, recent_requests: recent({ success: 0, failed: 0 }), quota: { signals: {} },
		...fields,
	};
}

const listing = {
	observed_at: "2026-10-15T11:59:00Z",
	files: [
		authFile({ id: "antigravity-a.json", auth_index: "0", name: "antigravity-a.json", type: "antigravity", provider: "antigravity",
			email: "a@example.test", account_type: "oauth", account: "a@example.test", priority: 1, success: 12, access_token: "sk-SECRET-token" }),
		authFile({ id: "antigravity-b.json", auth_index: "1", name: "antigravity-b.json", type: "antigravity", provider: "antigravity",
			email: "b@example.test", account_type: "oauth", account: "b@example.test", status: "error", status_message: "quota exhausted for gemini-3-pro",
			unavailable: true, next_retry_after: iso(90), failed: 4, quota: { observed_at: iso(-10), signals: { "x-ratelimit-remaining-requests": "0" } } }),
		authFile({ id: "antigravity-c.json", auth_index: "2", name: "antigravity-c.json", type: "antigravity", provider: "antigravity",
			email: "c@example.test", account_type: "oauth", account: "c@example.test", status: "error", status_message: "upstream returned 500", unavailable: true }),
		authFile({ id: "antigravity-d@example.test.json", auth_index: "3", name: "antigravity-d@example.test.json", type: "antigravity", provider: "antigravity",
			account_type: "oauth", status: "disabled", disabled: true }),
		authFile({ id: "claude:apikey:0", auth_index: "5", name: "claude:apikey:0", type: "claude", provider: "claude",
			account_type: "api_key", account: API_KEY_ACCOUNT, runtime_only: true, source: "memory" }),
		authFile({ id: "codex-e.json", auth_index: "4", name: "codex-e.json", type: "codex", provider: "codex",
			email: "e@example.test", account_type: "oauth", account: "e@example.test" }),
	],
};
const traffic = {
	claude: {
		"https://api.anthropic.test|sk-SECRET-traffic-1": { success: 10, failed: 2, recent_requests: recent({ success: 1, failed: 1 }) },
		"|sk-SECRET-traffic-2": { success: 5, failed: 0, recent_requests: recent({ success: 2, failed: 0 }) },
	},
	openrouter: { "https://openrouter.test/api/v1|sk-SECRET-traffic-3": { success: 1, failed: 0, recent_requests: [] } },
};

function setup(t: TestContext, files: { managementKey?: string; password?: string; yaml?: string } = {}) {
	resetManagementKeyCache();
	const agentDir = tempDir(t);
	const homeDir = tempDir(t);
	mkdirSync(join(agentDir, "pi-cliproxyapi-provider"));
	writeFileSync(join(agentDir, "pi-cliproxyapi-provider", "config.json"), JSON.stringify({
		providerName: "cpa", baseUrl: `${ORIGIN}/v1`, ...(files.managementKey ? { managementKey: files.managementKey } : {}),
	}));
	mkdirSync(join(homeDir, ".cli-proxy-api"));
	if (files.password) writeFileSync(join(homeDir, ".cli-proxy-api", ".management-password"), `${files.password}\n`);
	if (files.yaml) writeFileSync(join(homeDir, ".cli-proxy-api", "config.yaml"), files.yaml);
	return { agentDir, homeDir };
}

type Routes = {
	keys?: string[];
	listing?: unknown;
	plugin?: unknown;
	quota?: (request: RecordedRequest) => Response | Promise<Response>;
	/** Upstream provider APIs (antigravity quota RPC, OpenCode usage), checked before the management-key gate. */
	upstream?: (request: RecordedRequest) => Response | undefined;
	/** `POST /v0/management/auth-files/refresh`; emulating the proxy may rewrite the credential file. */
	refresh?: (request: RecordedRequest) => Response;
	/** Traffic payload; `{}` is the live empty state of a proxy with no recorded traffic. */
	traffic?: unknown;
	/** v0 auth-files and api-key-usage 404, as on a proxy that only serves the v8 family. */
	v0Missing?: boolean;
	/** No management secret configured: every management route 404s before authentication. */
	managementOff?: boolean;
	reject?: (request: RecordedRequest) => Response | undefined;
};

function proxy(routes: Routes = {}) {
	const accepted = routes.keys ?? [GOOD];
	const notFound = () => jsonResponse("404 page not found", 404, "Not Found");
	return fakeFetch((request) => {
		const upstream = routes.upstream?.(request);
		if (upstream) return upstream;
		const rejected = routes.reject?.(request);
		if (rejected) return rejected;
		const path = new URL(request.url).pathname;
		if (path === "/healthz") return jsonResponse({ status: "ok" });
		if (routes.managementOff) return notFound();
		if (!accepted.includes(request.headers.get("X-Management-Key") ?? "")) return jsonResponse({ error: "invalid management key" }, 401, "Unauthorized");
		if (path === "/v0/management/config") return jsonResponse({ debug: false });
		if (path === "/v0/management/auth-files") return routes.v0Missing ? notFound() : jsonResponse(routes.listing ?? listing);
		if (path === "/v8/management/credentials") return jsonResponse(routes.listing ?? listing);
		if (path === "/v0/management/api-key-usage") return routes.v0Missing ? notFound() : jsonResponse(routes.traffic ?? traffic);
		if (path === "/v8/management/observability/usage/api-keys") return jsonResponse(routes.traffic ?? traffic);
		if (path === "/v0/management/auth-files/refresh" && routes.refresh) return routes.refresh(request);
		if (path === "/v0/management/quota/providers") return jsonResponse(routes.plugin ?? { providers: [] });
		if (path === "/v0/management/quota/fetch" && routes.quota) return routes.quota(request);
		return notFound();
	});
}

const handshakeKeys = (requests: RecordedRequest[]) =>
	requests.filter((request) => request.url.endsWith("/v0/management/config")).map((request) => request.headers.get("X-Management-Key"));

function assertNoSecrets(text: string): void {
	for (const secret of SECRETS) assert.equal(text.includes(secret), false, "secret material must never be rendered");
	assert.doesNotMatch(text, /SECRET/);
}

test("secret-key line parsing handles quotes and comments without a YAML parser", () => {
	assert.equal(parseSecretKeyLine(`remote-management:\n  allow-remote: false\n  secret-key: "abc"\n`), "abc");
	assert.equal(parseSecretKeyLine(`  secret-key: 'a#b'`), "a#b");
	assert.equal(parseSecretKeyLine(`  secret-key: plain # note`), "plain");
	assert.equal(parseSecretKeyLine(`  secret-key: ""`), undefined);
	assert.equal(parseSecretKeyLine(`port: 8317`), undefined);
});

test("origin comes from the provider config or the env override", (t) => {
	const { agentDir, homeDir } = setup(t);
	assert.equal(resolveOrigin(adapterContext({ agentDir, homeDir })), ORIGIN);
	assert.equal(resolveOrigin(adapterContext({ agentDir, homeDir, env: { PI_USAGE_CPA_BASE_URL: "https://cpa.test:9000/v1" } })), "https://cpa.test:9000");
	assert.equal(resolveOrigin(adapterContext({ env: { PI_USAGE_CPA_BASE_URL: "file:///etc" } })), undefined);
	assert.equal(resolveOrigin(adapterContext()), undefined);
});

test("tab visibility requires /healthz 200; missing config makes no request", async (t) => {
	const { agentDir, homeDir } = setup(t);
	const healthy = proxy();
	assert.equal(await cliproxyapiAdapter.hasCredentials(adapterContext({ agentDir, homeDir, fetch: healthy.fetch })), true);
	assert.equal(healthy.requests[0]?.url, `${ORIGIN}/healthz`);
	assert.equal(healthy.requests[0]?.headers.get("X-Management-Key"), null, "health probe never carries a key");
	const down = fakeFetch(() => jsonResponse({}, 503));
	assert.equal(await cliproxyapiAdapter.hasCredentials(adapterContext({ agentDir, homeDir, fetch: down.fetch })), false);
	const refused = fakeFetch(() => { throw new TypeError("fetch failed"); });
	assert.equal(await cliproxyapiAdapter.hasCredentials(adapterContext({ agentDir, homeDir, fetch: refused.fetch })), false);
	const unconfigured = fakeFetch(() => jsonResponse({}));
	assert.equal(await cliproxyapiAdapter.hasCredentials(adapterContext({ fetch: unconfigured.fetch })), false);
	assert.equal(unconfigured.requests.length, 0);
});

test("key discovery order: env, agent config, management-password, unhashed config.yaml", (t) => {
	const { agentDir, homeDir } = setup(t, { managementKey: STALE, password: GOOD, yaml: "  secret-key: plain-yaml\n" });
	const { candidates } = managementKeyCandidates(adapterContext({ agentDir, homeDir, env: { PI_USAGE_CPA_MANAGEMENT_KEY: ENV_KEY } }));
	assert.deepEqual(candidates.map((candidate) => candidate.source), [
		"PI_USAGE_CPA_MANAGEMENT_KEY",
		"pi-cliproxyapi-provider/config.json managementKey",
		"~/.cli-proxy-api/.management-password",
		"~/.cli-proxy-api/config.yaml secret-key",
	]);
});

test("(a) a bcrypt-looking secret-key is skipped with a note and never sent", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD, yaml: `remote-management:\n  secret-key: "${HASH}"\n` });
	const { fetch, requests } = proxy();
	const ctx = adapterContext({ agentDir, homeDir, fetch });
	assert.deepEqual(managementKeyCandidates(ctx).candidates.map((candidate) => candidate.key), [GOOD]);
	const snapshot = await fetchCliproxySnapshot(ctx, undefined, now);
	assert.ok(snapshot.notes?.includes("Skipped the hashed secret-key in ~/.cli-proxy-api/config.yaml."));
	assert.equal(requests.some((request) => [...request.headers.values()].some((value) => value.includes(HASH))), false);
	const yamlOnly = setup(t, { yaml: `  secret-key: "${HASH}"\n` });
	const empty = proxy();
	await assert.rejects(fetchCliproxySnapshot(adapterContext({ ...yamlOnly, fetch: empty.fetch })), (error: unknown) =>
		error instanceof ProviderStateError && error.state === "setup"
		&& error.message === "No management key · set PI_USAGE_CPA_MANAGEMENT_KEY (config.yaml secret-key is hashed)");
	assert.equal(empty.requests.length, 0);
});

test("(b) the management-password candidate is accepted on the refresh after the agent-config candidate 401s, then cached", async (t) => {
	const { agentDir, homeDir } = setup(t, { managementKey: STALE, password: GOOD });
	const { fetch, requests } = proxy();
	const ctx = adapterContext({ agentDir, homeDir, fetch });
	await assert.rejects(fetchCliproxySnapshot(ctx, undefined, now), (error: unknown) => error instanceof ProviderStateError && error.state === "setup"
		&& error.message === "Management key from pi-cliproxyapi-provider/config.json managementKey rejected · retry to try the next candidate");
	assert.deepEqual(handshakeKeys(requests), [STALE], "one candidate per refresh");
	const snapshot = await fetchCliproxySnapshot(ctx, undefined, now);
	assert.deepEqual(handshakeKeys(requests), [STALE, GOOD]);
	assert.ok(snapshot.notes?.includes("Management key from ~/.cli-proxy-api/.management-password."));
	requests.length = 0;
	await fetchCliproxySnapshot(ctx, undefined, now);
	assert.equal(requests.some((request) => request.url.endsWith("/v0/management/config")), false, "accepted key cached for the session");
});

test("(c) rejected candidates are tried once per session, so refreshes cannot trip the 5-failure IP ban", async (t) => {
	const { agentDir, homeDir } = setup(t, { managementKey: STALE, password: "pw-SECRET-also-wrong" });
	const { fetch, requests } = proxy({ keys: ["something-else"] });
	const ctx = adapterContext({ agentDir, homeDir, fetch });
	const failure = () => fetchCliproxySnapshot(ctx).then(() => undefined, (caught: unknown) => caught);
	const first = await failure();
	assert.ok(first instanceof ProviderStateError && first.state === "setup");
	assert.equal(first.message, "Management key from pi-cliproxyapi-provider/config.json managementKey rejected · retry to try the next candidate");
	assert.equal(requests.length, 1);
	const error = await failure();
	assert.ok(error instanceof ProviderStateError);
	assert.equal(error.state, "setup");
	assert.equal(error.message, "No verified management key · 2 candidates rejected");
	assert.equal(requests.length, 2);
	for (let refresh = 0; refresh < 5; refresh += 1) await failure();
	assert.equal(requests.length, 2, "background refreshes never re-send a rejected key");
	const changed = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch, env: { PI_USAGE_CPA_MANAGEMENT_KEY: ENV_KEY } }))
		.then(() => undefined, (caught: unknown) => caught);
	assert.ok(changed instanceof ProviderStateError);
	assert.equal(changed.message, "No verified management key · 3 candidates rejected");
	assert.equal(requests.length, 3, "a new key value is a new candidate");
	for (const caught of [first, error, changed]) {
		assertNoSecrets(plain(formatProviderLines(theme, "CLIProxyAPI", { error: { message: caught.message, state: caught.state }, loading: false }, 60)).join("\n"));
	}
});

test("(d) a ban-shaped 403 or a 429 is a distinct blocked state and stops the candidate loop", async (t) => {
	const { agentDir, homeDir } = setup(t, { managementKey: STALE, password: GOOD });
	const banned = proxy({ reject: () => jsonResponse({ error: "IP banned due to too many failed attempts. Try again in 29m59.5s" }, 403, "Forbidden") });
	await assert.rejects(fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch: banned.fetch })), (error: unknown) =>
		error instanceof ProviderStateError && error.state === "blocked" && error.message === "Proxy banned this host's IP · retry in 29m59s");
	assert.equal(banned.requests.length, 1, "no further candidates are tried");
	const noDuration = proxy({ reject: () => jsonResponse({ error: "IP banned due to too many failed attempts" }, 403) });
	await assert.rejects(fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch: noDuration.fetch })), { message: "Proxy temporarily banned this host's IP" });
	const limited = proxy({ reject: () => jsonResponse({}, 429, "Too Many Requests") });
	await assert.rejects(fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch: limited.fetch })), (error: unknown) =>
		error instanceof ProviderStateError && error.state === "blocked");
	assert.equal(limited.requests.length, 1);
});

test("a later 401 re-resolves once; a later ban keeps the cached key", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	let rotate = false;
	let ban = false;
	const { fetch, requests } = proxy({
		keys: [GOOD, ENV_KEY],
		reject: (request) => ban ? jsonResponse({ error: "IP banned due to too many failed attempts. Try again in 5m" }, 403)
			: rotate && request.headers.get("X-Management-Key") === GOOD ? jsonResponse({}, 401) : undefined,
	});
	const ctx = adapterContext({ agentDir, homeDir, fetch, env: {} });
	await fetchCliproxySnapshot(ctx, undefined, now);
	rotate = true;
	requests.length = 0;
	const rotated = adapterContext({ agentDir, homeDir, fetch, env: { PI_USAGE_CPA_MANAGEMENT_KEY: ENV_KEY } });
	const snapshot = await fetchCliproxySnapshot(rotated, undefined, now);
	assert.ok(snapshot.notes?.includes("Management key from PI_USAGE_CPA_MANAGEMENT_KEY."));
	assert.equal(requests[0]?.headers.get("X-Management-Key"), GOOD, "cached key tried first");
	assert.equal(requests[1]?.headers.get("X-Management-Key"), ENV_KEY, "re-resolution restarts the chain");
	ban = true;
	await assert.rejects(fetchCliproxySnapshot(rotated, undefined, now), { message: "Proxy banned this host's IP · retry in 5m" });
	ban = false;
	requests.length = 0;
	await fetchCliproxySnapshot(rotated, undefined, now);
	assert.equal(requests.some((request) => request.url.endsWith("/v0/management/config")), false, "a ban does not invalidate the cached key");
});

test("v8 credential rows show status, status_message, failed count, priority and next_retry_after; traffic strips API keys", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const { fetch } = proxy();
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	assert.equal(snapshot.subtitle, "127.0.0.1:8317");
	assert.equal(snapshot.observedAt, Date.parse("2026-10-15T11:59:00Z") / 1000);
	assert.deepEqual(snapshot.rows.map((row) => [row.group, row.label, row.state]), [
		["Traffic", "claude", "15 ok · 2 failed · latest 11:55-12:00 3/1"],
		["Traffic", "openrouter", "1 ok · 0 failed"],
		["antigravity", "a@example.test", "ok · priority 1"],
		["antigravity", "antigravity-d@example.test", "disabled"],
		["antigravity", "b@example.test", `cooling down until ${formatClock(Date.parse(iso(90)) / 1000, now)} · quota exhausted for gemini-3-pro · 4 failed`],
		["antigravity", "c@example.test", "unavailable · upstream returned 500"],
		["claude", "claude:apikey:0", "ok"],
		["codex", "e@example.test", "ok"],
	]);
	assert.deepEqual(snapshot.notes?.slice(-1), ["Normalized quota needs a CLIProxyAPI quota plugin."]);
	assertNoSecrets(JSON.stringify(snapshot));
	for (const width of widths) {
		assertNoSecrets(plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, width, now)).join("\n"));
	}
	const text = plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, 120, now)).join("\n");
	assert.match(text, /^ {2}Traffic$/m);
	assert.match(text, /^ {2}antigravity$/m);
	assert.doesNotMatch(text, /Window|Used|Reset/, "columns without data are dropped");
});

test("v8 credentials and observability usage routes are used when the v0 routes are missing; quota has no v8 route", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const { fetch, requests } = proxy({ v0Missing: true });
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	assert.ok(requests.some((request) => request.url === `${ORIGIN}/v8/management/credentials`));
	assert.ok(requests.some((request) => request.url === `${ORIGIN}/v8/management/observability/usage/api-keys`));
	assert.equal(requests.some((request) => request.url.includes("/v8/management/quota")), false);
	assert.equal(snapshot.rows.filter((row) => row.group !== "Traffic").length, 6);
	assert.equal(snapshot.rows.filter((row) => row.group === "Traffic").length, 2);
});

test("an all-404 management API (no secret-key configured) is a setup state; the tab stays visible and the key is not rejected", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const routes: Routes = { managementOff: true };
	const off404 = proxy(routes);
	const ctx = adapterContext({ agentDir, homeDir, fetch: off404.fetch });
	assert.equal(await cliproxyapiAdapter.hasCredentials(ctx), true);
	await assert.rejects(fetchCliproxySnapshot(ctx, undefined, now), (error: unknown) => error instanceof ProviderStateError && error.state === "setup"
		&& error.message === "Management API is off · set remote-management.secret-key in the CLIProxyAPI config");
	routes.managementOff = false;
	const snapshot = await fetchCliproxySnapshot(ctx, undefined, now);
	assert.ok(snapshot.notes?.includes("Management key from ~/.cli-proxy-api/.management-password."));
	assert.deepEqual(handshakeKeys(off404.requests), [GOOD, GOOD]);
	routes.managementOff = true;
	await assert.rejects(fetchCliproxySnapshot(ctx, undefined, now), { message: "Management API is off · set remote-management.secret-key in the CLIProxyAPI config" });
	const lines = plain(formatProviderLines(theme, "CLIProxyAPI", { error: { message: "Management API is off · set remote-management.secret-key in the CLIProxyAPI config", state: "setup" }, loading: false }, 60));
	assert.ok(lines.some((line) => line.includes("Management API is off")));
});

test("every management request refuses redirects, so X-Management-Key is never re-sent to another origin", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const inner = proxy({ reject: (request) => request.url.startsWith(ORIGIN) && request.url.endsWith("/auth-files")
		? new Response(null, { status: 302, headers: { location: "https://evil.test/collect" } }) : undefined });
	// Emulates fetch redirect modes: "follow" re-sends custom headers such as X-Management-Key to the Location origin.
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const response = await inner.fetch(input, init);
		if (response.status < 300 || response.status >= 400) return response;
		if (init?.redirect === "error") throw new TypeError("fetch failed");
		return init?.redirect === "manual" ? response : await inner.fetch(response.headers.get("location")!, init);
	}) as typeof globalThis.fetch;
	const error = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now).then(() => undefined, (caught: unknown) => caught);
	assert.ok(error instanceof TypeError);
	assert.equal(inner.requests.some((request) => request.url.startsWith("https://evil.test")), false, "redirect target never contacted");
	const management = inner.requests.filter((request) => request.url.includes("/management/"));
	assert.ok(management.length >= 2);
	assert.ok(management.every((request) => request.redirect === "error"));
	assertNoSecrets(error.message);
});

test("a quota plugin adds normalized buckets as used percentages via v0 quota/fetch", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const bodies: unknown[] = [];
	const { fetch } = proxy({
		plugin: { providers: ["antigravity"] },
		quota: (request) => {
			bodies.push(JSON.parse(request.body ?? "{}"));
			return jsonResponse({ groups: [{ displayName: "gemini", buckets: [
				{ window: "5h", remainingFraction: 0.25, resetTime: iso(120), description: "Gemini Pro" },
				{ window: "weekly", remaining_fraction: 1 },
			] }] });
		},
	});
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	assert.deepEqual(bodies.map((body) => String((body as { auth_index: unknown }).auth_index)).sort(), ["0", "1", "2", "3"]);
	assert.ok(bodies.every((body) => (body as { provider: string }).provider === "antigravity"), "only plugin-served providers are queried");
	const row = snapshot.rows.find((candidate) => candidate.label === "a@example.test");
	assert.deepEqual(row?.windows, [
		{ label: "gemini 5h", usedPercent: 75, resetsAt: Date.parse(iso(120)) / 1000, note: "Gemini Pro" },
		{ label: "gemini weekly", usedPercent: 0 },
	]);
	assert.equal(snapshot.notes?.includes("Normalized quota needs a CLIProxyAPI quota plugin."), false);
	const text = plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, 160, now)).join("\n");
	assert.match(text, /gemini 5h\s+█{8}░░\s+75%\s+~2h/);
});

test("quota fetches run at most 4 at a time", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const many = { files: Array.from({ length: 10 }, (_, index) => authFile({ auth_index: String(index), provider: "antigravity", email: `u${index}@example.test`, account_type: "oauth" })) };
	let inFlight = 0;
	let peak = 0;
	const { fetch } = proxy({
		listing: many,
		plugin: { providers: ["antigravity"] },
		quota: async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setImmediate(resolve));
			inFlight -= 1;
			return jsonResponse({ groups: [{ displayName: "gemini", buckets: [{ window: "5h", remainingFraction: 0.5 }] }] });
		},
	});
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	assert.equal(peak, 4);
	assert.equal(snapshot.rows.filter((row) => row.windows.length === 1).length, 10);
});

test("concurrent quota 401s share one re-resolution and each request retries once", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	let rotated = false;
	const { fetch, requests } = proxy({
		keys: [GOOD, ENV_KEY],
		plugin: { providers: ["antigravity"] },
		reject: (request) => rotated && request.url.endsWith("/quota/fetch") && request.headers.get("X-Management-Key") === GOOD ? jsonResponse({}, 401) : undefined,
		quota: () => jsonResponse({ groups: [{ displayName: "gemini", buckets: [{ window: "5h", remainingFraction: 0.5 }] }] }),
	});
	await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	rotated = true;
	requests.length = 0;
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch, env: { PI_USAGE_CPA_MANAGEMENT_KEY: ENV_KEY } }), undefined, now);
	assert.deepEqual(handshakeKeys(requests), [ENV_KEY], "one shared re-resolution");
	assert.equal(requests.filter((request) => request.url.endsWith("/quota/fetch") && request.headers.get("X-Management-Key") === GOOD).length, 4, "all four were in flight together");
	assert.equal(snapshot.notes?.some((note) => note.startsWith("Quota plugin fetch failed")), false);
	assert.equal(snapshot.rows.filter((row) => row.group === "antigravity" && row.windows.length === 1).length, 4);
	assert.ok(snapshot.notes?.includes("Management key from PI_USAGE_CPA_MANAGEMENT_KEY."));
});

test("(f) an api_key credential's account (the plaintext upstream key) never reaches rows, notes or errors", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const { fetch } = proxy({
		plugin: { providers: ["claude"] },
		quota: () => jsonResponse({ error: `failed to fetch quota: bad key ${API_KEY_ACCOUNT}` }, 502, "Bad Gateway"),
	});
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	assert.equal(snapshot.rows.find((row) => row.group === "claude")?.label, "claude:apikey:0");
	assert.ok(snapshot.notes?.includes("Quota plugin fetch failed for 1 credential."));
	assertNoSecrets(JSON.stringify(snapshot));
	for (const width of [...widths, 160]) assertNoSecrets(plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, width, now)).join("\n"));
	// Fields that could carry the key are dropped too; a missing account_type is treated like api_key.
	const parsed = parseCredentials({ files: [
		{ provider: "claude", account_type: "api_key", account: API_KEY_ACCOUNT, label: API_KEY_ACCOUNT, name: `${API_KEY_ACCOUNT}.json`, status: "error", status_message: `401 invalid key ${API_KEY_ACCOUNT}` },
		{ provider: "claude", account: API_KEY_ACCOUNT, id: `claude:${API_KEY_ACCOUNT}` },
	] });
	assert.deepEqual(parsed.map((credential) => credential.account), ["credential", "credential"]);
	assertNoSecrets(JSON.stringify(parsed));
	assertNoSecrets(parsed.map((credential) => JSON.stringify(credentialRow(credential, [], now))).join("\n"));
	const failing = proxy({ reject: (request) => request.url.endsWith("/auth-files") ? jsonResponse({ error: API_KEY_ACCOUNT }, 500, "Internal Server Error") : undefined });
	const error = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch: failing.fetch })).then(() => undefined, (caught: unknown) => caught);
	assert.ok(error instanceof Error);
	assertNoSecrets(error.message);
});

test("legacy pre-v8 quota.exceeded/reason/next_recover_at still drive state; v8 statuses other than active show as-is", () => {
	const credentials = parseCredentials({ files: [
		{ provider: "gemini", email: "a@example.test", quota: { exceeded: true, reason: "weekly limit" } },
		{ provider: "gemini", email: "b@example.test", quota: { exceeded: true, reason: "quota exhausted", next_recover_at: iso(30) } },
		{ provider: "gemini", email: "c@example.test", account_type: "oauth", status: "refreshing" },
	] });
	assert.deepEqual(credentials.map((credential) => credentialRow(credential, [], now).state), [
		"exceeded · weekly limit",
		`cooling down until ${formatClock(Date.parse(iso(30)) / 1000, now)} · quota exhausted`,
		"refreshing",
	]);
});

test("parsers tolerate unknown shapes", () => {
	assert.deepEqual(parseCredentials(null), []);
	assert.deepEqual(parseCredentials([{ provider: "x" }]).map((credential) => credential.account), ["credential"]);
	assert.deepEqual(parseTraffic([1, 2]), []);
	assert.deepEqual(parseTraffic({ observed_at: 5, gemini: { "k|sk-SECRET": "bad" } }), [{ provider: "gemini", success: 0, failed: 0 }]);
	assert.deepEqual(parseTraffic({ gemini: { "k|sk-SECRET": { success: 1, recent_requests: [{ time: "09:00-09:05", success: 1 }, { time: "09:05-09:10\x1b[2J" }] } } }),
		[{ provider: "gemini", success: 1, failed: 0, recent: { label: "09:05-09:10 [2J", success: 0, failed: 0 } }], "last bucket wins, label sanitized, not parsed as a time");
	assert.deepEqual(parseQuotaBuckets({ groups: [{ buckets: [{}] }] }), [{ label: "quota" }]);
	assert.deepEqual(parseQuotaBuckets({ groups: [{ display_name: "claude", buckets: [{ window: "weekly" }] }, { name: "ignored", buckets: [{}] }] }).map((window) => window.label),
		["claude weekly", "quota"]);
});

test("(e) resolved keys never appear in rendered lines or error messages", async (t) => {
	const { agentDir, homeDir } = setup(t, { managementKey: STALE, password: GOOD, yaml: `  secret-key: "${HASH}"\n` });
	const failing = proxy({ reject: (request) => request.url.endsWith("/auth-files") ? jsonResponse({ error: `bad key ${GOOD}` }, 500, "Internal Server Error") : undefined });
	const ctx = adapterContext({ agentDir, homeDir, fetch: failing.fetch });
	const rejected = await fetchCliproxySnapshot(ctx).then(() => undefined, (caught: unknown) => caught);
	assert.ok(rejected instanceof ProviderStateError);
	assertNoSecrets(rejected.message);
	const error = await fetchCliproxySnapshot(ctx).then(() => undefined, (caught: unknown) => caught);
	assert.ok(error instanceof Error);
	assert.equal(error.message, "CLIProxyAPI request failed (500 Internal Server Error)");
	assertNoSecrets(error.message);
	assertNoSecrets(plain(formatProviderLines(theme, "CLIProxyAPI", { error: { message: error.message }, loading: false }, 80)).join("\n"));
});

// Upstream provider quota: antigravity RPC and OpenCode usage endpoint.

const AG_TOKEN = "ya29-SECRET-antigravity-token";
const AG_TOKEN_FRESH = "ya29-SECRET-antigravity-fresh";
const OC_KEY = "sk-SECRET-opencode-key";
const AG_DAILY_URL = "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary";
const AG_FALLBACK_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const OC_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** Verified live antigravity response shape: groups of buckets with a remaining fraction. */
const antigravityQuota = { groups: [{ displayName: "Gemini Models", buckets: [
	{ bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", window: "5h", resetTime: "2026-10-15T20:06:12Z", remainingFraction: 0.25 },
	{ bucketId: "gemini-weekly", displayName: "Weekly Limit Remaining", window: "weekly", resetTime: "2026-10-18T20:06:12Z", remainingFraction: 1 },
] }] };
const opencodeQuota = { usage: { rolling: { status: "ok", percent: 34, resetsAt: iso(45) }, weekly: { status: "ok", percent: 12 }, monthly: { status: "maintenance" } } };
const upstreamSecrets = (text: string): void => {
	assertNoSecrets(text);
	assert.doesNotMatch(text, /ses_/, "session ids are never rendered");
	assert.doesNotMatch(text, /Bearer/, "tokens are never rendered");
};

test("antigravity quota buckets invert the remaining fraction into raw used percentages, label windows and convert resets", () => {
	assert.deepEqual(parseAntigravityQuota(antigravityQuota), [{ group: "Gemini Models", windows: [
		{ label: "5h", usedPercent: 75, resetsAt: Date.parse("2026-10-15T20:06:12Z") / 1000 },
		{ label: "weekly", usedPercent: 0, resetsAt: Date.parse("2026-10-18T20:06:12Z") / 1000 },
	] }]);
	// The window label falls back to the bucket displayName, then bucketId; snake_case fields are read too.
	assert.deepEqual(parseAntigravityQuota({ groups: [{ display_name: "Other Models", buckets: [
		{ displayName: "Fallback Label", remainingFraction: 0.5, resetTime: "2026-10-16T00:00:00Z" },
		{ bucketId: "id-only", remaining_fraction: 1.25 },
	] }] }), [{ group: "Other Models", windows: [
		{ label: "Fallback Label", usedPercent: 50, resetsAt: Date.parse("2026-10-16T00:00:00Z") / 1000 },
		{ label: "id-only", usedPercent: -25 },
	] }], "a fraction above 1 stays raw; only the display clamps");
	// Unknown shapes degrade to a `?%` window with a short note, never a throw.
	assert.deepEqual(parseAntigravityQuota({}), [{ group: "Antigravity", windows: [{ label: "quota", note: "unrecognized response" }] }]);
	assert.deepEqual(parseAntigravityQuota({ groups: [{ displayName: "Gemini Models", buckets: [{}] }] }),
		[{ group: "Gemini Models", windows: [{ label: "quota", note: "unrecognized" }] }]);
});

test("antigravity and opencode-go credentials fetch per-credential quota from the provider APIs with client headers", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const agFile = join(homeDir, ".cli-proxy-api", "antigravity-a.json");
	const ocFile = join(homeDir, ".cli-proxy-api", "provider-bundle-x.json");
	writeFileSync(agFile, JSON.stringify({ type: "antigravity", email: "a@example.test", project_id: "proj-1", access_token: AG_TOKEN, expired: iso(60) }));
	writeFileSync(ocFile, JSON.stringify({ type: "opencode-go", label: "Main", api_key: OC_KEY }));
	const { fetch, requests } = proxy({
		listing: { observed_at: "2026-10-15T11:59:00Z", files: [
			authFile({ id: "antigravity-a.json", auth_index: "0", name: "antigravity-a.json", type: "antigravity", provider: "antigravity",
				email: "a@example.test", account_type: "oauth", account: "a@example.test" }),
			authFile({ id: "provider-bundle-x.json", auth_index: "1", name: "provider-bundle-x.json", type: "opencode-go", provider: "opencode-go",
				label: "Main", account_type: "api_key", account: OC_KEY }),
		] },
		upstream: (request) => request.url === AG_DAILY_URL ? jsonResponse(antigravityQuota)
			: request.url === OC_USAGE_URL ? jsonResponse(opencodeQuota) : undefined,
	});
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	const antigravityRequest = requests.find((request) => request.url === AG_DAILY_URL);
	assert.equal(antigravityRequest?.method, "POST");
	assert.equal(antigravityRequest?.body, "{}");
	assert.equal(antigravityRequest?.headers.get("User-Agent"), "antigravity/cli/1.2.4 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)");
	assert.equal(antigravityRequest?.headers.get("Authorization"), `Bearer ${AG_TOKEN}`);
	const opencodeRequest = requests.find((request) => request.url === OC_USAGE_URL);
	assert.equal(opencodeRequest?.headers.get("User-Agent"), "opencode/latest/2.0.18/cli");
	assert.equal(opencodeRequest?.headers.get("x-opencode-client"), "cli");
	assert.match(opencodeRequest?.headers.get("x-opencode-session") ?? "", /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, "fresh canonical session id per request");
	assert.equal(opencodeRequest?.headers.get("Authorization"), `Bearer ${OC_KEY}`);
	const geminiRow = snapshot.rows.find((row) => row.label === "a@example.test");
	assert.equal(geminiRow?.group, "Gemini Models");
	assert.deepEqual(geminiRow?.windows, [
		{ label: "5h", usedPercent: 75, resetsAt: Date.parse("2026-10-15T20:06:12Z") / 1000 },
		{ label: "weekly", usedPercent: 0, resetsAt: Date.parse("2026-10-18T20:06:12Z") / 1000 },
	]);
	const opencodeRow = snapshot.rows.find((row) => row.label === "Main");
	assert.equal(opencodeRow?.group, "opencode-go");
	assert.deepEqual(opencodeRow?.windows, [
		{ label: "Rolling", usedPercent: 34, resetsAt: Date.parse(iso(45)) / 1000 },
		{ label: "Weekly", usedPercent: 12 },
		{ label: "Monthly", note: "status: maintenance" },
	], "percent is already a used percentage and is used as-is");
	for (const width of [...widths, 160]) upstreamSecrets(plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, width, now)).join("\n"));
	upstreamSecrets(JSON.stringify(snapshot));
	const text = plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, 160, now)).join("\n");
	assert.match(text, /^ {2}Gemini Models$/m);
	assert.match(text, /5h\s+█{8}░░\s+75%/);
	assert.match(text, /Rolling\s+███░░░░░░░\s+34%/);
	// A second request in the same test never reuses a session id.
	const before = opencodeRequest?.headers.get("x-opencode-session");
	await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	const second = requests.filter((request) => request.url === OC_USAGE_URL).at(-1)?.headers.get("x-opencode-session");
	assert.notEqual(second, before);
});

test("an expired antigravity token triggers one proxy refresh per snapshot, re-reads the file and calls the provider with the fresh token", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const fileName = "antigravity-a.json";
	const filePath = join(homeDir, ".cli-proxy-api", fileName);
	writeFileSync(filePath, JSON.stringify({ type: "antigravity", email: "a@example.test", access_token: AG_TOKEN, expired: iso(-5) }));
	let refreshes = 0;
	let providerCalls = 0;
	const { fetch, requests } = proxy({
		listing: { observed_at: "2026-10-15T11:59:00Z", files: [authFile({ id: fileName, auth_index: "0", name: fileName, type: "antigravity", provider: "antigravity",
			email: "a@example.test", account_type: "oauth", account: "a@example.test" })] },
		upstream: (request) => {
			if (request.url !== AG_DAILY_URL) return undefined;
			providerCalls += 1;
			assert.equal(request.headers.get("Authorization"), `Bearer ${AG_TOKEN_FRESH}`, "the provider is called with the re-read token");
			return jsonResponse(antigravityQuota);
		},
		refresh: (request) => {
			refreshes += 1;
			assert.equal(request.method, "POST");
			assert.equal(request.body, JSON.stringify({ all: true }));
			writeFileSync(filePath, JSON.stringify({ type: "antigravity", email: "a@example.test", access_token: AG_TOKEN_FRESH, expired: iso(60) }));
			return jsonResponse({ ok: true, results: [] });
		},
	});
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	assert.equal(refreshes, 1, "the refresh route is called once per snapshot");
	assert.equal(providerCalls, 1);
	assert.ok(requests.findIndex((request) => request.url.endsWith("/auth-files/refresh")) < requests.findIndex((request) => request.url === AG_DAILY_URL));
	assert.equal(requests.some((request) => request.url.endsWith("/v8/management/credentials/refresh")), false);
	assert.equal(snapshot.rows.find((row) => row.label === "a@example.test")?.windows.length, 2);
	upstreamSecrets(JSON.stringify(snapshot));
});

test("a still-expired token after the refresh calls no provider and shows the token expired state", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const fileName = "antigravity-a.json";
	const fileBody = JSON.stringify({ type: "antigravity", email: "a@example.test", access_token: AG_TOKEN, expired: iso(-5) });
	writeFileSync(join(homeDir, ".cli-proxy-api", fileName), fileBody);
	const staleListing = { observed_at: "2026-10-15T11:59:00Z", files: [authFile({ id: fileName, auth_index: "0", name: fileName, type: "antigravity", provider: "antigravity",
		email: "a@example.test", account_type: "oauth", account: "a@example.test" })] };
	const providerCalls = { count: 0 };
	const upstream = (request: RecordedRequest) => {
		if (request.url !== AG_DAILY_URL && request.url !== AG_FALLBACK_URL) return undefined;
		providerCalls.count += 1;
		return jsonResponse(antigravityQuota);
	};
	// The refresh succeeds but the file still says the token is expired.
	const stillExpired = proxy({ listing: staleListing, upstream, refresh: () => jsonResponse({ ok: true, results: [] }) });
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch: stillExpired.fetch }), undefined, now);
	assert.equal(providerCalls.count, 0, "no provider call for a still-expired token");
	const row = snapshot.rows.find((candidate) => candidate.label === "a@example.test");
	assert.equal(row?.state, "token expired");
	assert.deepEqual(row?.windows, []);
	upstreamSecrets(JSON.stringify(snapshot));
	// A failing refresh is isolated the same way instead of failing the snapshot.
	const failedRefresh = proxy({ listing: staleListing, upstream, refresh: () => jsonResponse({ error: "refresh failed" }, 500, "Internal Server Error") });
	const refreshed = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch: failedRefresh.fetch }), undefined, now);
	assert.equal(providerCalls.count, 0);
	assert.equal(refreshed.rows.find((candidate) => candidate.label === "a@example.test")?.state, "token expired");
});

test("a failing upstream quota is isolated per credential: one 500 does not fail the snapshot", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	writeFileSync(join(homeDir, ".cli-proxy-api", "antigravity-a.json"), JSON.stringify({ type: "antigravity", email: "a@example.test", access_token: AG_TOKEN, expired: iso(60) }));
	writeFileSync(join(homeDir, ".cli-proxy-api", "antigravity-b.json"), JSON.stringify({ type: "antigravity", email: "b@example.test", access_token: AG_TOKEN_FRESH, expired: iso(60) }));
	const { fetch, requests } = proxy({
		listing: { observed_at: "2026-10-15T11:59:00Z", files: [
			authFile({ id: "antigravity-a.json", auth_index: "0", name: "antigravity-a.json", type: "antigravity", provider: "antigravity",
				email: "a@example.test", account_type: "oauth", account: "a@example.test" }),
			authFile({ id: "antigravity-b.json", auth_index: "1", name: "antigravity-b.json", type: "antigravity", provider: "antigravity",
				email: "b@example.test", account_type: "oauth", account: "b@example.test" }),
		] },
		upstream: (request) => {
			if (request.url !== AG_DAILY_URL && request.url !== AG_FALLBACK_URL) return undefined;
			// Credential a fails on both endpoints; credential b succeeds.
			return request.headers.get("Authorization") === `Bearer ${AG_TOKEN}` ? jsonResponse({ error: "backend error" }, 500, "Internal Server Error")
				: jsonResponse(antigravityQuota);
		},
	});
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	const failed = snapshot.rows.find((row) => row.label === "a@example.test");
	assert.equal(failed?.group, "antigravity");
	assert.deepEqual(failed?.windows, [], "the failed credential keeps its plain row");
	assert.equal(failed?.state, "ok");
	const healthy = snapshot.rows.find((row) => row.label === "b@example.test");
	assert.equal(healthy?.windows.length, 2);
	assert.ok(snapshot.notes?.includes("Upstream quota failed for 1 credential."));
	assert.deepEqual(requests.filter((request) => request.url === AG_FALLBACK_URL).length, 1, "a 500 falls back to the production endpoint once");
	assert.equal(requests.filter((request) => request.url === AG_DAILY_URL).length, 2, "both credentials still use the daily endpoint first");
	upstreamSecrets(JSON.stringify(snapshot));
	upstreamSecrets(plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, 160, now)).join("\n"));
	// A non-5xx (here a Cloudflare-style 403) does not fall back and is isolated the same way.
	const refused = proxy({
		listing: { observed_at: "2026-10-15T11:59:00Z", files: [authFile({ id: "antigravity-a.json", auth_index: "0", name: "antigravity-a.json",
			type: "antigravity", provider: "antigravity", email: "a@example.test", account_type: "oauth", account: "a@example.test" })] },
		upstream: (request) => request.url === AG_DAILY_URL ? jsonResponse("403 Error 1010: Access denied", 403, "Forbidden") : undefined,
	});
	const refusedSnapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch: refused.fetch }), undefined, now);
	assert.equal(refused.requests.some((request) => request.url === AG_FALLBACK_URL), false, "no fallback on a non-5xx");
	assert.deepEqual(refusedSnapshot.rows.find((row) => row.label === "a@example.test")?.windows, []);
	upstreamSecrets(JSON.stringify(refusedSnapshot));
});

test("an empty traffic response renders a dim note instead of silence", async (t) => {
	const { agentDir, homeDir } = setup(t, { password: GOOD });
	const { fetch } = proxy({ traffic: {} });
	const snapshot = await fetchCliproxySnapshot(adapterContext({ agentDir, homeDir, fetch }), undefined, now);
	assert.equal(snapshot.rows.some((row) => row.group === "Traffic"), false);
	assert.ok(snapshot.notes?.includes("No API-key traffic recorded."));
	const text = plain(formatProviderLines(theme, "CLIProxyAPI", { snapshot, loading: false }, 80, now)).join("\n");
	assert.match(text, /No API-key traffic recorded\./);
});
