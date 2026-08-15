import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "../index.ts";

function token(accountId: string): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})).toString("base64url");
	return `header.${payload}.signature`;
}

const model = {
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

test("weekly quota never reuses another account after auth resolution fails", async () => {
	const originalFetch = globalThis.fetch;
	let failAuth = false;
	globalThis.fetch = async () => new Response(JSON.stringify({
		rate_limit: { secondary_window: { used_percent: 25, window_minutes: 10_080 } },
	}), { status: 200 });
	const ctx = {
		hasUI: true,
		model,
		modelRegistry: {
			getProviderAuth: async () => {
				if (failAuth) throw new Error("auth failed");
				return { auth: { apiKey: token("account-a"), baseUrl: "https://chatgpt.com/backend-api" } };
			},
		},
	};
	try {
		assert.equal(await __testing.fetchWeeklyUsageLeft(ctx as never), 75);
		failAuth = true;
		assert.equal(await __testing.fetchWeeklyUsageLeft(ctx as never), undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ambiguous reset retries preserve the redeem request id", async () => {
	const state = { requestId: "redeem-id", phase: "pending" as const } as any;
	const seen: string[] = [];
	const consume = async (_headers: Headers, requestId: string) => {
		seen.push(requestId);
		if (seen.length === 1) throw new Error("timeout");
		return { outcome: "already_redeemed", windowsReset: 1 } as const;
	};

	await assert.rejects(__testing.runResetRequest(state, new Headers(), undefined, consume));
	assert.equal(state.phase, "ambiguous");
	assert.equal(state.requestId, "redeem-id");
	await __testing.runResetRequest(state, new Headers(), undefined, consume);
	assert.equal(state.phase, "locked");
	assert.deepEqual(seen, ["redeem-id", "redeem-id"]);
});
