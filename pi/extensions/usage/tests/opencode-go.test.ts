import assert from "node:assert/strict";
import test from "node:test";
import { ProviderStateError } from "../core.ts";
import { isOfficialOrigin, opencodeGoAdapter, parseOpencodeGoPayload } from "../providers/opencode-go.ts";
import { formatProviderLines } from "../render.ts";
import { adapterContext, fakeFetch, jsonResponse, plain, theme } from "./helpers.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
// Mirrors this account's live reference: rolling 8% (1h44m), weekly 22% (3d9h), monthly 57% (11d1h).
const live = {
	usage: {
		rolling: { status: "ok", percent: 8, resetsAt: iso(104) },
		weekly: { status: "ok", percent: 22, resetsAt: iso((3 * 24 + 9) * 60) },
		monthly: { status: "ok", percent: 57, resetsAt: iso((11 * 24 + 1) * 60) },
	},
};

test("parses the live OpenCode Go shape into rolling, weekly and monthly used windows", () => {
	const snapshot = parseOpencodeGoPayload(live, now / 1000);
	assert.equal(snapshot.providerId, "opencode-go");
	assert.equal(snapshot.notes, undefined);
	assert.deepEqual(snapshot.rows[0]?.windows, [
		{ label: "Rolling", usedPercent: 8, resetsAt: now / 1000 + 104 * 60 },
		{ label: "Weekly", usedPercent: 22, resetsAt: now / 1000 + (3 * 24 + 9) * 3600 },
		{ label: "Monthly", usedPercent: 57, resetsAt: now / 1000 + (11 * 24 + 1) * 3600 },
	]);
	const text = plain(formatProviderLines(theme, "OpenCode Go", { snapshot, loading: false }, 80, now)).join("\n");
	assert.match(text, /Rolling\s+█░░░░░░░░░\s+8%\s+~1h/);
	assert.match(text, /Weekly\s+██░░░░░░░░\s+22%\s+~3d 9h/);
	assert.match(text, /Monthly\s+██████░░░░\s+57%\s+~11d 1h/);
	assert.doesNotMatch(text, /left/i);
});

test("accepts snake_case variants and an unwrapped root", () => {
	const snapshot = parseOpencodeGoPayload({ weekly: { used_percent: 12.5, resets_at: 1_900_000_000 } });
	assert.deepEqual(snapshot.rows[0]?.windows[1], { label: "Weekly", usedPercent: 12.5, resetsAt: 1_900_000_000 });
});

test("unknown fields and statuses degrade to ?% plus notes instead of throwing", () => {
	const snapshot = parseOpencodeGoPayload({
		usage: {
			rolling: { status: "ok", consumption: "lots" },
			weekly: { status: "rate-limited", percent: 100 },
			monthly: { status: "maintenance\u001b[31m", percent: 3 },
		},
	});
	assert.deepEqual(snapshot.rows[0]?.windows, [
		{ label: "Rolling", note: "unrecognized fields" },
		{ label: "Weekly", usedPercent: 100, note: "rate-limited" },
		{ label: "Monthly", usedPercent: 3, note: "status: maintenance [31m" },
	]);
	const empty = parseOpencodeGoPayload(null);
	assert.deepEqual(empty.rows[0]?.windows.map((window) => window.note), ["not reported", "not reported", "not reported"]);
	assert.deepEqual(empty.notes, ["OpenCode Go returned no recognizable usage percentages."]);
	const text = plain(formatProviderLines(theme, "OpenCode Go", { snapshot: empty, loading: false }, 80)).join("\n");
	assert.match(text, /Rolling\s+░{10}\s+\?%/);
});

test("only the official origin receives the key", async () => {
	assert.equal(isOfficialOrigin(undefined), true);
	assert.equal(isOfficialOrigin("https://opencode.ai/zen/go/v1"), true);
	assert.equal(isOfficialOrigin("https://opencode.ai.evil.test/zen"), false);
	assert.equal(isOfficialOrigin("http://opencode.ai/zen"), false);
	const { fetch, requests } = fakeFetch(() => jsonResponse(live));
	const proxied = adapterContext({ fetch, getProviderAuth: async () => ({ apiKey: "sk-SECRET-zen", baseUrl: "https://proxy.test/v1" }) });
	await assert.rejects(opencodeGoAdapter.fetch(proxied), (error: unknown) => error instanceof ProviderStateError && error.state === "setup" && !/SECRET/.test(error.message));
	assert.equal(requests.length, 0);
});

test("adapter fetches the fixed usage endpoint with bearer auth and gates tabs on stored credentials", async () => {
	const { fetch, requests } = fakeFetch(() => jsonResponse(live));
	const ctx = adapterContext({
		fetch,
		hasProviderCredentials: (id) => id === "opencode-go",
		getProviderAuth: async () => ({ apiKey: "sk-SECRET-zen", baseUrl: "https://opencode.ai/zen/go/v1" }),
	});
	assert.equal(await opencodeGoAdapter.hasCredentials(ctx), true);
	assert.equal(await opencodeGoAdapter.hasCredentials(adapterContext()), false);
	const snapshot = await opencodeGoAdapter.fetch(ctx);
	assert.equal(snapshot.rows[0]?.windows[2]?.usedPercent, 57);
	assert.equal(requests[0]?.url, "https://opencode.ai/zen/go/v1/usage");
	assert.equal(requests[0]?.headers.get("authorization"), "Bearer sk-SECRET-zen");
	assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
});
