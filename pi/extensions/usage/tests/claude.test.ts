import assert from "node:assert/strict";
import test from "node:test";
import { ProviderStateError } from "../core.ts";
import {
	claudeAdapter,
	parseClaudeHeaders,
	parseClaudeUsagePayload,
	resetClaudeCredentialCache,
} from "../providers/claude.ts";
import { adapterContext, fakeFetch, jsonResponse, plain, theme, widths } from "./helpers.ts";
import { formatFrame, formatProviderBody, formatProviderLines } from "../render.ts";

/** Trimmed from a real `GET /api/oauth/usage` response for a Pro subscription. */
const LIVE_USAGE = {
	five_hour: { utilization: 38.0, resets_at: "2026-10-15T21:29:59.658891+00:00", limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null },
	seven_day: { utilization: 8.0, resets_at: "2026-10-18T02:59:59.884522+00:00" },
	seven_day_sonnet: null,
	seven_day_opus: null,
	seven_day_oauth_apps: null,
	extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
	spend: { used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0, severity: "normal", enabled: false, balance: null },
	seven_day_breakdown: {
		as_of: "2026-10-15T16:58:37.691599+00:00",
		rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }],
	},
	limits: [
		{ kind: "session", group: "session", percent: 38, severity: "normal", resets_at: "2026-10-15T21:29:59.884503+00:00", scope: null, is_active: true },
		{ kind: "weekly_all", group: "weekly", percent: 8, severity: "normal", resets_at: "2026-10-18T02:59:59.884522+00:00", scope: null, is_active: false },
	],
};

test("parses the live Claude usage payload as used percentages", () => {
	const snapshot = parseClaudeUsagePayload(LIVE_USAGE);
	const text = plain([JSON.stringify(snapshot)]).join("");
	assert.equal(snapshot.providerId, "claude");
	assert.equal(snapshot.statusPercent, 38, "the binding limit drives the footer");
	const session = snapshot.rows.find((row) => row.label === "5h session");
	assert.equal(session?.windows[0]?.usedPercent, 38);
	assert.equal(session?.windows[0]?.label, "5h");
	assert.equal(session?.windows[0]?.resetsAt, Date.parse("2026-10-15T21:29:59.884503+00:00") / 1000);
	const weekly = snapshot.rows.find((row) => row.label === "weekly · all models");
	assert.equal(weekly?.windows[0]?.usedPercent, 8);
	const share = snapshot.rows.find((row) => row.group === "Weekly usage share");
	assert.equal(share?.label, "Claude Code");
	assert.equal(share?.windows[0]?.usedPercent, 100, "week shares are rendered as-is, labelled a share");
	assert.equal(share?.windows[0]?.note, "of weekly usage");
	assert.ok(snapshot.rows.every((row) => row.state === undefined), "normal severity adds no state");
	assert.doesNotMatch(text, /left/i, "percentages are used, never left");
});

test("falls back to raw buckets when the normalized limits array is absent", () => {
	const snapshot = parseClaudeUsagePayload({
		five_hour: { utilization: 0.42, resets_at: "2026-10-15T21:00:00Z" },
		seven_day: { utilization: 92.5 },
		seven_day_opus: { utilization: 0.5 },
		seven_day_sonnet: null,
	});
	const five = snapshot.rows.find((row) => row.label === "5h");
	assert.equal(five?.windows[0]?.usedPercent, 42, "fractions below 1 are scaled to percent");
	const week = snapshot.rows.find((row) => row.label === "weekly");
	assert.equal(week?.windows[0]?.usedPercent, 92.5, "values above 1 are already percent");
	assert.equal(snapshot.rows.find((row) => row.label === "weekly · Opus")?.windows[0]?.usedPercent, 50);
	assert.equal(snapshot.rows.some((row) => row.label.includes("Sonnet")), false, "null windows are skipped");
	assert.equal(snapshot.statusPercent, 92.5);
});

test("an unfamiliar payload yields notes, never a throw", () => {
	const snapshot = parseClaudeUsagePayload({ something: "else" });
	assert.deepEqual(snapshot.rows, []);
	assert.deepEqual(snapshot.notes, ["Claude returned no usage windows."]);
	assert.equal(snapshot.statusPercent, undefined);
	assert.equal(parseClaudeUsagePayload(null).rows.length, 0);
	assert.equal(parseClaudeUsagePayload("nope").rows.length, 0);
});

test("severity and pay-as-you-go credits surface without being read as limits", () => {
	const snapshot = parseClaudeUsagePayload({
		...LIVE_USAGE,
		limits: [{ kind: "session", percent: 100, severity: "exceeded", resets_at: "2026-10-15T21:00:00Z" }],
		spend: { enabled: true, percent: 12, used: { amount_minor: 1234, currency: "USD", exponent: 2 }, limit: { amount_minor: 5000, currency: "USD", exponent: 2 } },
	});
	assert.equal(snapshot.rows.find((row) => row.label === "5h session")?.state, "exceeded");
	assert.ok(snapshot.notes?.includes("severity: exceeded"));
	const credits = snapshot.rows.find((row) => row.label === "extra usage");
	assert.equal(credits?.windows[0]?.usedPercent, 12);
	assert.equal(credits?.state, "USD 12.34 / USD 50.00");
});

test("live rate-limit headers become a snapshot; utilizations are fractions", () => {
	const snapshot = parseClaudeHeaders({
		"anthropic-ratelimit-unified-status": "allowed",
		"anthropic-ratelimit-unified-5h-utilization": "0.38",
		"anthropic-ratelimit-unified-5h-reset": "1760563800",
		"anthropic-ratelimit-unified-7d-utilization": "0.08",
		"anthropic-ratelimit-unified-7d-reset": "1760763600",
		"anthropic-ratelimit-unified-7d_oi-utilization": "0.01",
	});
	assert.equal(snapshot?.statusPercent, 38);
	const rows = snapshot?.rows ?? [];
	assert.equal(rows.find((row) => row.label === "5h")?.windows[0]?.usedPercent, 38);
	assert.equal(rows.find((row) => row.label === "weekly")?.windows[0]?.usedPercent, 8);
	assert.equal(rows.find((row) => row.label === "weekly · overage")?.windows[0]?.usedPercent, 1);
	assert.equal(rows.find((row) => row.label === "5h")?.windows[0]?.resetsAt, 1760563800);
	assert.ok(snapshot?.notes?.includes("Live from Claude rate-limit headers"));
});

test("headers from other providers or with a blocked status are handled honestly", () => {
	assert.equal(parseClaudeHeaders({ "content-type": "application/json" }), undefined, "unrelated headers are ignored");
	assert.equal(parseClaudeHeaders(undefined), undefined);
	const blocked = parseClaudeHeaders({
		"anthropic-ratelimit-unified-status": "rejected",
		"anthropic-ratelimit-unified-overage-status": "exhausted",
		"anthropic-ratelimit-unified-representative-claim": "five_hour",
		"anthropic-ratelimit-unified-5h-utilization": "1",
	});
	assert.equal(blocked?.rows[0]?.windows[0]?.usedPercent, 100, "a header utilization of exactly 1 means 100%");
	assert.equal(blocked?.subtitle, "five_hour");
	assert.ok(blocked?.notes?.some((note) => note.includes("limit status: rejected")));
	assert.ok(blocked?.notes?.some((note) => note.includes("overage: exhausted")));
});

test("a non-numeric live utilization is unknown, not NaN", () => {
	assert.equal(
		parseClaudeHeaders({ "anthropic-ratelimit-unified-5h-utilization": "n/a" }),
		undefined,
		"a window with neither a usable utilization nor a reset is dropped",
	);
	const snapshot = parseClaudeHeaders({
		"anthropic-ratelimit-unified-status": "allowed",
		"anthropic-ratelimit-unified-5h-utilization": "n/a",
		"anthropic-ratelimit-unified-5h-reset": "1760563800",
		"anthropic-ratelimit-unified-7d-utilization": "0.08",
	});
	assert.ok(snapshot);
	const five = snapshot.rows.find((row) => row.label === "5h");
	assert.equal(five?.windows[0]?.usedPercent, undefined, "a non-numeric header is unknown, not NaN");
	assert.equal(five?.windows[0]?.resetsAt, 1760563800, "its reset still renders");
	assert.equal(snapshot.statusPercent, 8, "the footer skips the unknown window instead of publishing NaN");
	assert.doesNotMatch(JSON.stringify(snapshot), /NaN/);
	const rendered = plain(formatProviderLines(theme, "Claude", { snapshot, loading: false }, 80)).join("\n");
	assert.doesNotMatch(rendered, /NaN/, "the tab never prints NaN%");
	assert.match(rendered, /\?%/, "an unknown window renders as ?% with an empty bar");
});

test("the adapter sends the Claude usage request with the bearer token and beta header", async () => {
	resetClaudeCredentialCache();
	const { fetch, requests } = fakeFetch(() => jsonResponse(LIVE_USAGE));
	const ctx = adapterContext({
		fetch,
		env: { PI_USAGE_CLAUDE_TOKEN: "sk-ant-secret-token" },
	});
	const snapshot = await claudeAdapter.fetch(ctx);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.url, "https://api.anthropic.com/api/oauth/usage");
	assert.equal(requests[0]!.method, "GET");
	assert.equal(requests[0]!.headers.get("authorization"), "Bearer sk-ant-secret-token");
	assert.equal(requests[0]!.headers.get("anthropic-beta"), "oauth-2025-04-20");
	assert.equal(requests[0]!.redirect, "error", "the credential is never replayed to a redirect target");
	assert.equal(snapshot.statusPercent, 38);
	const rendered = JSON.stringify(snapshot);
	assert.equal(rendered.includes("sk-ant-secret-token"), false, "the token never reaches a snapshot");
	resetClaudeCredentialCache();
});

test("credentials gate: missing login hides the tab, expired login asks for a refresh", async () => {
	resetClaudeCredentialCache();
	const missing = adapterContext({ env: {} });
	assert.equal(await claudeAdapter.hasCredentials(missing), false, "no store and no token means no tab");
	await assert.rejects(
		() => claudeAdapter.fetch(missing),
		(error: unknown) => error instanceof ProviderStateError && error.state === "setup",
	);

	resetClaudeCredentialCache();
	const expired = adapterContext({
		env: {},
		readKeychainItem: async () => JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-expired", expiresAt: Date.now() - 1_000 } }),
	});
	assert.equal(await claudeAdapter.hasCredentials(expired), true, "a stored but expired login still gets a tab");
	await assert.rejects(
		() => claudeAdapter.fetch(expired),
		(error: unknown) => error instanceof ProviderStateError && error.state === "auth-refresh" && !error.message.includes("sk-ant-expired"),
		"fetching with an expired token reports a refresh state without leaking the token",
	);
	resetClaudeCredentialCache();
});

test("the keychain store is read through the injected seam, and its token is never rendered", async () => {
	resetClaudeCredentialCache();
	const { fetch } = fakeFetch(() => jsonResponse(LIVE_USAGE));
	const ctx = adapterContext({
		fetch,
		env: {},
		readKeychainItem: async () => JSON.stringify({
			claudeAiOauth: { accessToken: "sk-ant-from-keychain", expiresAt: Date.now() + 3_600_000, subscriptionType: "pro" },
		}),
	});
	assert.equal(await claudeAdapter.hasCredentials(ctx), true);
	const snapshot = await claudeAdapter.fetch(ctx);
	assert.equal(snapshot.subtitle, "pro", "the subscription type labels the tab when the payload omits it");
	for (const width of widths) {
		const body = formatProviderBody(theme, "Claude", { snapshot, loading: false }, width);
		const lines = plain(formatFrame(theme, { titles: ["Claude"], active: 0, body: [...body.head, ...body.band.map((entry) => entry.line), ...body.foot] }, width));
		assert.equal(lines.join("\n").includes("sk-ant-from-keychain"), false, "no token in the rendered frame");
	}
	resetClaudeCredentialCache();
});

test("adapter identity and aliases match how the bridge reports its provider", () => {
	assert.equal(claudeAdapter.id, "claude");
	assert.equal(claudeAdapter.title, "Claude");
	assert.deepEqual(claudeAdapter.aliases, ["claude-bridge", "anthropic"]);
});
