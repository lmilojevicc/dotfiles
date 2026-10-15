import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ProviderStateError } from "../core.ts";
import {
	codexSnapshot,
	extractAccountId,
	isCanonicalBaseUrl,
	openaiCodexAdapter,
	parseCodexUsagePayload,
} from "../providers/openai-codex.ts";
import { formatFrame, formatProviderLines } from "../render.ts";
import { adapterContext, fakeFetch, jsonResponse, jwt, theme, widths } from "./helpers.ts";

const primaryReset = Math.floor(Date.now() / 1000) + 3600;
const secondaryReset = Math.floor(Date.now() / 1000) + 86_400;

// Canonical vector shared with codex-enhanced/tests/core.test.ts.
const canonical = {
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 25, limit_window_seconds: 18_000, resets_at: primaryReset },
		secondary_window: { used_percent: 40, window_minutes: 10_080, reset_at: secondaryReset },
	},
	additional_rate_limits: [
		{ metered_feature: "review", limit_name: "Code review", rate_limit: { primary: { used_percent: 10, window_minutes: 60 } } },
	],
	rate_limit_reset_credits: { available_count: "2", credits: [{ id: "credit-1", status: "available", expires_at: "2030-01-01T00:00:00Z" }, null] },
};

test("parses the canonical codex quota payload", () => {
	const usage = parseCodexUsagePayload(canonical);
	assert.equal(usage.planType, "plus");
	assert.deepEqual(usage.limits[0], {
		limitId: "codex",
		primary: { usedPercent: 25, windowMinutes: 300, resetsAt: primaryReset },
		secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: secondaryReset },
	});
	assert.deepEqual(usage.limits[1], {
		limitId: "review",
		limitName: "Code review",
		primary: { usedPercent: 10, windowMinutes: 60, resetsAt: undefined },
		secondary: undefined,
	});
});

test("codex snapshot is one row per limit with used percentages, window labels and plan subtitle; reset credits ignored", () => {
	const snapshot = codexSnapshot(parseCodexUsagePayload(canonical), 1234.9);
	assert.equal(snapshot.subtitle, "plus");
	assert.equal(snapshot.observedAt, 1234);
	assert.deepEqual(snapshot.rows, [
		{ label: "codex", windows: [
			{ label: "5h", usedPercent: 25, resetsAt: primaryReset },
			{ label: "weekly", usedPercent: 40, resetsAt: secondaryReset },
		] },
		{ label: "Code review", windows: [{ label: "1h", usedPercent: 10 }] },
	]);
	assert.doesNotMatch(JSON.stringify(snapshot), /credit/i);
});

test("numeric parsing is strict and disagreeing durations become unknown", () => {
	const usage = parseCodexUsagePayload({
		rate_limit: {
			primary_window: { used_percent: "100", window_minutes: 300 },
			secondary_window: { used_percent: 50, window_minutes: 10_080, limit_window_seconds: 18_000 },
		},
	});
	assert.equal(usage.limits[0]?.primary?.usedPercent, undefined);
	assert.equal(usage.limits[0]?.secondary?.windowMinutes, undefined);
	const rows = codexSnapshot(usage).rows;
	assert.deepEqual(rows[0]?.windows.map((window) => window.label), ["5h", "secondary"]);
});

test("a lone weekly window normalizes into the secondary slot", () => {
	const usage = parseCodexUsagePayload({ rate_limit: { primary_window: { used_percent: 70, window_minutes: 10_080 } } });
	assert.equal(usage.limits[0]?.primary, undefined);
	assert.equal(usage.limits[0]?.secondary?.usedPercent, 70);
	assert.deepEqual(codexSnapshot(usage).rows[0]?.windows, [{ label: "weekly", usedPercent: 70 }]);
});

test("non-record payloads yield an empty snapshot with a note, not a throw", () => {
	const snapshot = codexSnapshot(parseCodexUsagePayload("nope"));
	assert.deepEqual(snapshot.rows, [{ label: "codex", windows: [] }]);
	assert.deepEqual(snapshot.notes, ["Codex returned no usage windows."]);
});

test("provider text (plan_type, limit_name, metered_feature) is sanitized to one line without control characters", () => {
	const usage = parseCodexUsagePayload({
		plan_type: "plus\n\x1b[2Jpwned",
		additional_rate_limits: [
			{ metered_feature: "rev\x1b]0;title\x07iew", rate_limit: { primary: { used_percent: 10, window_minutes: 60 } } },
			{ metered_feature: "x", limit_name: "Code\r\nreview\u009b", rate_limit: { primary: { used_percent: 20, window_minutes: 60 } } },
		],
	});
	assert.equal(usage.planType, "plus [2Jpwned");
	assert.equal(usage.limits[1]?.limitId, "rev ]0;title iew");
	assert.equal(usage.limits[2]?.limitName, "Code review");
	const snapshot = codexSnapshot(usage, 0);
	for (const width of widths) {
		const lines = formatFrame(theme, { titles: ["Codex"], active: 0, body: formatProviderLines(theme, "Codex", { snapshot, loading: false }, width, 0) }, width);
		for (const line of lines) {
			const unstyled = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.doesNotMatch(unstyled, /[\u0000-\u001f\u007f-\u009f]/, "no control characters beyond theme styling");
			assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
		}
	}
});

test("canonical base URL and JWT account id rules", () => {
	assert.equal(isCanonicalBaseUrl(undefined), true);
	assert.equal(isCanonicalBaseUrl("https://chatgpt.com/backend-api/"), true);
	assert.equal(isCanonicalBaseUrl("https://chatgpt.com/backend-api/codex"), false);
	assert.equal(isCanonicalBaseUrl("https://chatgpt.com/backend-api/codex", true), true);
	assert.equal(isCanonicalBaseUrl("http://chatgpt.com/backend-api"), false);
	assert.equal(isCanonicalBaseUrl("https://chatgpt.com:8443/backend-api"), false);
	assert.equal(isCanonicalBaseUrl("https://example.test/backend-api"), false);
	assert.equal(extractAccountId(jwt("acct-1")), "acct-1");
	assert.equal(extractAccountId("not-a-jwt"), undefined);
});

test("codex adapter sends the codex-enhanced headers to /wham/usage", async () => {
	const token = jwt("acct-SECRET-free");
	const { fetch, requests } = fakeFetch(() => jsonResponse(canonical));
	const ctx = adapterContext({
		fetch,
		hasProviderCredentials: (id) => id === "openai-codex",
		getProviderAuth: async (id) => id === "openai-codex" ? { apiKey: token, baseUrl: "https://chatgpt.com/backend-api" } : undefined,
	});
	assert.equal(await openaiCodexAdapter.hasCredentials(ctx), true);
	const snapshot = await openaiCodexAdapter.fetch(ctx);
	assert.equal(snapshot.rows.length, 2);
	assert.equal(requests.length, 1);
	const [request] = requests;
	assert.equal(request!.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(request!.method, "GET");
	assert.equal(request!.headers.get("authorization"), `Bearer ${token}`);
	assert.equal(request!.headers.get("chatgpt-account-id"), "acct-SECRET-free");
	assert.equal(request!.headers.get("OAI-Language"), "en");
	assert.equal(request!.headers.get("originator"), "pi");
	assert.equal(request!.headers.get("accept"), "application/json");
	assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(token));
});

test("codex adapter refuses unresolved auth, noncanonical endpoints and tokens without an account id before any request", async () => {
	const { fetch, requests } = fakeFetch(() => jsonResponse(canonical));
	const cases = [
		{ auth: undefined, state: "auth-refresh" },
		{ auth: { apiKey: jwt("a"), baseUrl: "https://example.test" }, state: "setup" },
		{ auth: { apiKey: "opaque-token" }, state: "setup" },
	] as const;
	for (const item of cases) {
		const ctx = adapterContext({ fetch, hasProviderCredentials: () => true, getProviderAuth: async () => item.auth });
		await assert.rejects(openaiCodexAdapter.fetch(ctx), (error: unknown) => error instanceof ProviderStateError && error.state === item.state);
	}
	assert.equal(requests.length, 0);
});

test("codex HTTP failures carry a short message without the response body", async () => {
	const { fetch } = fakeFetch(() => jsonResponse({ detail: "token sk-SECRET" }, 429, "Too Many Requests"));
	const ctx = adapterContext({ fetch, getProviderAuth: async () => ({ apiKey: jwt("a") }) });
	await assert.rejects(openaiCodexAdapter.fetch(ctx), { message: "Codex request failed (429 Too Many Requests)" });
});
