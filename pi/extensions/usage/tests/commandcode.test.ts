import assert from "node:assert/strict";
import test from "node:test";
import { ProviderStateError } from "../core.ts";
import {
	alphaOrigin,
	commandcodeAdapter,
	formatTokens,
	parseCommandCodeSnapshot,
	parseCredits,
	parseSubscription,
	parseSummary,
	parseWhoami,
} from "../providers/commandcode.ts";
import { formatProviderLines } from "../render.ts";
import { adapterContext, fakeFetch, jsonResponse, plain, theme } from "./helpers.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const iso = (milliseconds: number) => new Date(now + milliseconds).toISOString();
/** Tip of the adapter's own alpha origin: the provider base is one level below it. */
const ALPHA = "https://api.commandcode.ai";

/** Mirrors the upstream `/commandcode-quota` test fixtures: two burn windows plus the billing pool. */
const WHOAMI = { org: { id: "org_1", login: "milo-org" }, user: { userName: "milo", keyName: "CI key" } };
const CREDITS = {
	credits: { monthlyCredits: 4.25, purchasedCredits: 1.5, freeCredits: 0 },
	windowLimits: {
		fiveHour: { used: 3.2, cap: 9.75, resetAt: iso(104 * 60_000) },
		weekly: { used: 7.5, cap: 30, resetAt: iso((3 * 24 + 9) * 3_600_000) },
	},
};
const SUBSCRIPTION = {
	data: {
		planId: "pro_monthly",
		status: "active",
		currentPeriodStart: iso(-45 * 86_400_000),
		currentPeriodEnd: iso(12 * 86_400_000),
	},
};
const SUMMARY = { totalCost: 10.25, totalCount: 456, totalTokens: 2_340_000 };

function commandcodeRoutes(handlers: { whoami?: unknown; credits?: unknown; subscriptions?: unknown; summary?: unknown }) {
	return fakeFetch((request) => {
		if (request.url.endsWith("/alpha/whoami")) {
			if (typeof handlers.whoami === "number") return jsonResponse("", handlers.whoami, "Unauthorized");
			return jsonResponse(handlers.whoami ?? WHOAMI);
		}
		if (request.url.includes("/billing/credits")) {
			if (typeof handlers.credits === "number") return jsonResponse("", handlers.credits, "Internal Server Error");
			return jsonResponse(handlers.credits ?? CREDITS);
		}
		if (request.url.includes("/billing/subscriptions")) {
			if (typeof handlers.subscriptions === "number") return jsonResponse("", handlers.subscriptions, "Internal Server Error");
			return jsonResponse(handlers.subscriptions ?? SUBSCRIPTION);
		}
		if (request.url.includes("/usage/summary")) {
			if (typeof handlers.summary === "number") return jsonResponse("", handlers.summary, "Internal Server Error");
			return jsonResponse(handlers.summary ?? SUMMARY);
		}
		throw new Error(`unexpected request: ${request.url}`);
	});
}

function authenticated(handlers: Parameters<typeof commandcodeRoutes>[0]) {
	const { fetch, requests } = commandcodeRoutes(handlers);
	const ctx = adapterContext({
		fetch,
		hasProviderCredentials: (id) => id === "commandcode",
		getProviderAuth: async () => ({ apiKey: "cc-SECRET-key", baseUrl: `${ALPHA}/provider/v1` }),
	});
	return { ctx, requests };
}

test("parses credits, subscription and summary into used percentages and notes", () => {
	const snapshot = parseCommandCodeSnapshot({ account: parseWhoami(WHOAMI)!, credits: CREDITS, subscription: SUBSCRIPTION, summary: SUMMARY }, now / 1000);
	assert.deepEqual(snapshot.rows, [{
		label: "Credits",
		windows: [
			{ label: "5h", usedPercent: (3.2 / 9.75) * 100, resetsAt: now / 1000 + 104 * 60, note: "$3.20 of $9.75" },
			{ label: "weekly", usedPercent: 25, resetsAt: now / 1000 + (3 * 24 + 9) * 3600, note: "$7.50 of $30.00" },
			// pool = remaining 5.75 + billing-period spend 10.25, matching the upstream "% used".
			{ label: "period", usedPercent: (10.25 / 16) * 100, note: "remaining $5.75 of $16.00" },
		],
	}]);
	assert.equal(snapshot.statusPercent, (10.25 / 16) * 100, "the worst constraint drives the footer");
	assert.equal(snapshot.subtitle, "pro monthly");
	assert.equal(snapshot.observedAt, Math.floor(now / 1000));
	assert.deepEqual(snapshot.notes, [
		// The org login wins over the user name, like the upstream whoami parse.
		"Account milo-org · key \"CI key\"",
		"Sources: monthly $4.25 / purchased $1.50",
		"Usage: $10.25 · 456 requests · 2.3M tokens",
		"Plan pro monthly (active) · renews Oct 27 (12d)",
	]);
});

test("renders the snapshot in the shared table, used percentages only", () => {
	const snapshot = parseCommandCodeSnapshot({ account: parseWhoami(WHOAMI)!, credits: CREDITS, subscription: SUBSCRIPTION, summary: SUMMARY }, now / 1000);
	const text = plain(formatProviderLines(theme, "Command Code", { snapshot, loading: false }, 80, now)).join("\n");
	assert.match(text, /Command Code · pro monthly/);
	assert.match(text, /5h\s+███░░░░░░░\s+33%\s+~1h\s+\$3\.20 of \$9\.75/);
	assert.match(text, /weekly\s+███░░░░░░░\s+25%\s+~3d 9h\s+\$7\.50 of \$30\.00/);
	assert.match(text, /period\s+██████░░░░\s+64%\s+reset \?\s+remaining \$5\.75 of \$16\.00/);
	assert.doesNotMatch(text, /left/i);
	assert.doesNotMatch(text, /SECRET/);
});

test("sections that fail or stop parsing become unavailable notes, not zero rows", () => {
	const timeout = new DOMException("timed out", "TimeoutError");
	const snapshot = parseCommandCodeSnapshot({
		account: parseWhoami(WHOAMI)!,
		subscription: SUBSCRIPTION,
		summary: SUMMARY,
		unavailable: { credits: "HTTP 500", summary: "timed out" },
	}, now / 1000);
	assert.deepEqual(snapshot.rows, [{ label: "Credits", windows: [{ label: "period", note: "$10.25 spent" }] }]);
	assert.equal(snapshot.statusPercent, undefined, "no pool and no window limits means no footer percent");
	assert.match(snapshot.notes!.join("\n"), /credits: HTTP 500/);
	assert.match(snapshot.notes!.join("\n"), /summary: timed out/);
	const text = plain(formatProviderLines(theme, "Command Code", { snapshot, loading: false }, 80, now)).join("\n");
	assert.match(text, /period\s+░{10}\s+\?%\s+reset \?\s+\$10\.25 spent/);

	// A section resolved to nothing renders neither rows nor pool data: the fetch layer is
	// expected to have marked it unavailable, so the builder only sees absent entries.
	const empty = parseCommandCodeSnapshot({
		account: parseWhoami(WHOAMI)!,
		unavailable: { credits: "unrecognized response", summary: "unrecognized response" },
	}, now / 1000);
	assert.deepEqual(empty.rows, [] as never[]);
	assert.match(empty.notes!.join("\n"), /credits: unrecognized response/);
	assert.match(empty.notes!.join("\n"), /summary: unrecognized response/);
});

test("a 200 section whose shape no longer parses is an explicit unavailable note", async () => {
	const { ctx } = authenticated({ subscriptions: {}, summary: {} });
	const snapshot = await commandcodeAdapter.fetch(ctx);
	assert.match(snapshot.notes!.join("\n"), /subscription: unrecognized response/);
	assert.match(snapshot.notes!.join("\n"), /summary: unrecognized response/);
	assert.equal(snapshot.rows.length, 1, "the credits windows still render");
});

test("empty credits and the org-id parameter round-trip through the fetch", async () => {
	const { ctx, requests } = authenticated({
		credits: { credits: { monthlyCredits: 0 } },
		subscriptions: { data: { planId: "free" } },
		summary: { totalCost: 0.5, totalCount: 3 },
	});
	const snapshot = await commandcodeAdapter.fetch(ctx);
	assert.deepEqual(snapshot.rows[0]?.windows, [{ label: "period", usedPercent: 100, note: "remaining $0.00 of $0.50" }]);
	assert.equal(snapshot.subtitle, "free");
	assert.equal(snapshot.statusPercent, 100);
	assert.equal(requests[0]?.url, `${ALPHA}/alpha/whoami`);
	assert.equal(requests[1]?.url, `${ALPHA}/alpha/billing/credits?orgId=org_1`);
	assert.equal(requests[2]?.url, `${ALPHA}/alpha/billing/subscriptions?orgId=org_1`);
		// No subscription period start, so the summary has no `since` parameter.
	assert.equal(requests[3]?.url, `${ALPHA}/alpha/usage/summary?orgId=org_1`);
	assert.equal(requests[0]?.headers.get("authorization"), "Bearer cc-SECRET-key");
	assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});

test("the billing summary is scoped to the subscription's period start", async () => {
	const { ctx, requests } = authenticated({});
	await commandcodeAdapter.fetch(ctx);
	assert.equal(
		requests[3]?.url,
		`${ALPHA}/alpha/usage/summary?orgId=org_1&since=${encodeURIComponent(String(SUBSCRIPTION.data.currentPeriodStart))}`,
	);
});

test("the adapter gates the tab on stored credentials and sends the key to the official alpha origin", async () => {
	const { ctx, requests } = authenticated({});
	assert.equal(await commandcodeAdapter.hasCredentials(ctx), true);
	assert.equal(await commandcodeAdapter.hasCredentials(adapterContext()), false);
	const snapshot = await commandcodeAdapter.fetch(ctx);
	assert.equal(snapshot.rows.length, 1);
	assert.equal(requests.length, 4);
});

test("401 and 403 on any section are the auth-refresh state, after whoami only", async () => {
	{
		const { ctx, requests } = authenticated({ whoami: 401 });
		await assert.rejects(commandcodeAdapter.fetch(ctx), (error: unknown) =>
			error instanceof ProviderStateError && error.state === "auth-refresh"
			&& error.message === "Command Code rejected the API key · run /login commandcode");
		assert.equal(requests.length, 1);
	}
	{
		const { ctx, requests } = authenticated({ credits: 403 });
		await assert.rejects(commandcodeAdapter.fetch(ctx), (error: unknown) =>
			error instanceof ProviderStateError && error.state === "auth-refresh"
			&& /rejected the API key/.test(error.message));
		assert.equal(requests.length, 3, "whoami plus the parallel credits/subscriptions pair, then stop");
		assert.ok(!requests.some((request) => request.url.includes("/usage/summary")), "the summary request is not spent");
	}
	{
		const { ctx, requests } = authenticated({ summary: 403 });
		await assert.rejects(commandcodeAdapter.fetch(ctx), (error: unknown) =>
			error instanceof ProviderStateError && error.state === "auth-refresh");
		assert.equal(requests.length, 4, "summary answers 403 after credits and subscriptions were fine");
	}
});

test("an unrecognized account response or no recognized data is a plain error", async () => {
	{
		const { ctx } = authenticated({ whoami: { users: [] } });
		await assert.rejects(commandcodeAdapter.fetch(ctx), /unrecognized account response/);
	}
	{
		const { ctx } = authenticated({ credits: 500, subscriptions: 500, summary: 500 });
		await assert.rejects(commandcodeAdapter.fetch(ctx), /no recognized usage data for the account/);
	}
});

test("whoami parses org and user logins, the raw org id and the key name", () => {
	assert.deepEqual(parseWhoami(WHOAMI), { login: "milo-org", orgId: "org_1", keyName: "CI key" });
	assert.deepEqual(parseWhoami({ user: { userName: "solo" } }), { login: "solo", orgId: null });
	assert.deepEqual(parseWhoami({ user: { name: "named", displayName: "displayed" } }), { login: "named", orgId: null, keyName: "displayed" });
	assert.equal(parseWhoami({ user: {} }), null);
	assert.equal(parseWhoami(null), null);
});

test("section parsers keep the upstream strictness", () => {
	assert.equal(parseCredits({ credits: {} }), null);
	assert.equal(parseCredits({ nope: 1 }), null);
	assert.deepEqual(parseCredits({ credits: { monthlyCredits: -1 } }), null);
	assert.deepEqual(parseCredits({ credits: { monthlyCredits: 4, freeCredits: 0 } }), {
		monthlyCredits: 4, purchasedCredits: 0, freeCredits: 0, remainingCredits: 4, windowLimits: [],
	});
	// A zero window pair renders nothing upstream; ms and ISO resetAt both normalize to seconds.
	assert.deepEqual(parseCredits({ credits: { monthlyCredits: 1 }, windowLimits: { fiveHour: { used: 0, cap: 0 } } })?.windowLimits, []);
	assert.deepEqual(parseCredits({ credits: { monthlyCredits: 1 }, windowLimits: { weekly: { used: 1, cap: 4, resetAt: iso(60_000) } } })?.windowLimits, [
		{ window: "weekly", used: 1, cap: 4, resetAt: now / 1000 + 60 },
	]);
	assert.equal(parseSubscription({ data: {} }), null);
	assert.deepEqual(parseSubscription({ data: { status: "past_due", currentPeriodEnd: now } }), {
		planId: null, status: "past_due", currentPeriodStart: null, currentPeriodEnd: String(now),
	});
	assert.equal(parseSummary({ totalCost: 1 }), null);
	assert.deepEqual(parseSummary({ totalCost: 1.5, totalCount: 2, tokens: 999 }), { totalCost: 1.5, totalCount: 2, totalTokens: 999 });
	assert.equal(parseSummary({ totalCost: "1", totalCount: 2 }), null, "numeric strings are not amounts");
});

test("the alpha origin follows the chat provider base, stripping only the known suffix", () => {
	assert.equal(alphaOrigin(undefined), ALPHA);
	assert.equal(alphaOrigin(""), ALPHA);
	assert.equal(alphaOrigin(`${ALPHA}/provider/v1`), ALPHA);
	assert.equal(alphaOrigin(`${ALPHA}/provider/v1/`), ALPHA);
	assert.equal(alphaOrigin("https://cc.test/api"), "https://cc.test/api");
});

test("token formatting matches the upstream dashboard", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(12_340), "12.3k");
	assert.equal(formatTokens(2_340_000), "2.3M");
	assert.equal(formatTokens(1_500_000_000), "1.5B");
});
