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
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
};

test("weekly quota uses provider auth independently of the selected model and never reuses stale auth", async () => {
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
		const usage = await __testing.fetchUsage(ctx as never);
		assert.equal(usage.accountKey, "account:account-a");
		assert.equal(usage.limits[0]?.secondary?.usedPercent, 25);
		assert.equal((await __testing.resolveResetAccount(ctx as never)).key, "account:account-a");
		assert.equal(await __testing.fetchWeeklyUsageLeft(ctx as never), 75);
		failAuth = true;
		assert.equal(await __testing.fetchWeeklyUsageLeft(ctx as never), undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("account switches invalidate both reset confirmation presses until current usage is refreshed", () => {
	const usageA = {
		accountKey: "account:account-a",
		limits: [],
		resetCredits: {
			availableCount: 1,
			credits: [{ id: "credit-a", status: "available" }],
		},
	};
	const usageB = {
		accountKey: "account:account-b",
		limits: [],
		resetCredits: {
			availableCount: 1,
			credits: [{ id: "credit-b", status: "available" }],
		},
	};
	let postCount = 0;
	const executeIfRedeem = (action: ReturnType<typeof __testing.decideResetAction>) => {
		if (action.kind === "redeem") postCount += 1;
	};

	const switchedBeforeFirstPress = __testing.decideResetAction("account:account-b", usageA, undefined, undefined);
	executeIfRedeem(switchedBeforeFirstPress);
	assert.equal(switchedBeforeFirstPress.kind, "refresh");
	assert.equal(postCount, 0);

	const firstPressForA = __testing.decideResetAction("account:account-a", usageA, undefined, undefined);
	assert.equal(firstPressForA.kind, "arm");
	const switchedBeforeSecondPress = __testing.decideResetAction("account:account-b", usageA, "account:account-a", undefined);
	executeIfRedeem(switchedBeforeSecondPress);
	assert.equal(switchedBeforeSecondPress.kind, "refresh");
	assert.equal(postCount, 0);

	const firstPressAfterBRefresh = __testing.decideResetAction("account:account-b", usageB, undefined, undefined);
	assert.equal(firstPressAfterBRefresh.kind, "arm");
	const secondPressAfterBRefresh = __testing.decideResetAction("account:account-b", usageB, "account:account-b", undefined);
	executeIfRedeem(secondPressAfterBRefresh);
	assert.equal(secondPressAfterBRefresh.kind, "redeem");
	assert.equal(secondPressAfterBRefresh.kind === "redeem" ? secondPressAfterBRefresh.state.creditId : undefined, "credit-b");
	assert.equal(postCount, 1);
});

test("aborted compaction cancels while a genuine remote failure delegates to local compaction", async () => {
	const compactionModel = {
		id: "gpt-5.4",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
	};
	const controller = new AbortController();
	controller.abort();
	const abortedEvent = {
		branchEntries: [],
		preparation: { firstKeptEntryId: "kept", tokensBefore: 1 },
		signal: controller.signal,
	} as never;
	assert.deepEqual(await __testing.runCompactionHook(abortedEvent, { model: compactionModel } as never, { tools: [] }), {
		cancel: true,
	});

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response("unsupported", { status: 400 });
	const activeEvent = {
		branchEntries: [{
			type: "message",
			id: "user-1",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		}],
		preparation: { firstKeptEntryId: "kept", tokensBefore: 1 },
		signal: new AbortController().signal,
	} as never;
	const ctx = {
		model: compactionModel,
		getSystemPrompt: () => "system",
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: token("account-a"), baseUrl: "https://chatgpt.com/backend-api" },
			}),
			complete: async () => ({ content: [{ type: "text", text: "summary" }] }),
		},
	} as never;
	try {
		assert.equal(await __testing.runCompactionHook(activeEvent, ctx, { tools: [] }), undefined);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ambiguous reset retries preserve the credit and redeem request ids", async () => {
	const state = { requestId: "redeem-id", creditId: "credit-id", phase: "pending" as const } as any;
	const seen: Array<[string, string]> = [];
	const consume = async (_headers: Headers, creditId: string, requestId: string) => {
		seen.push([creditId, requestId]);
		if (seen.length === 1) throw new Error("timeout");
		return { outcome: "already_redeemed", windowsReset: 1 } as const;
	};

	await assert.rejects(__testing.runResetRequest(state, new Headers(), undefined, consume));
	assert.equal(state.phase, "ambiguous");
	assert.equal(state.requestId, "redeem-id");
	assert.equal(state.creditId, "credit-id");
	await __testing.runResetRequest(state, new Headers(), undefined, consume);
	assert.equal(state.phase, "locked");
	assert.deepEqual(seen, [["credit-id", "redeem-id"], ["credit-id", "redeem-id"]]);
});

test("reset redemption fails safely without a usable credit id", async () => {
	await assert.rejects(
		__testing.consumeResetCredit(new Headers({ "chatgpt-account-id": "account-a" }), "", "redeem-a"),
		/No usable reset credit ID/,
	);
});

test("reset redemption sends the current account, credit, and idempotency ids", async () => {
	const originalFetch = globalThis.fetch;
	let body: unknown;
	globalThis.fetch = async (_input, init) => {
		body = JSON.parse(String(init?.body));
		return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }), { status: 200 });
	};
	try {
		const headers = new Headers({ "chatgpt-account-id": "account-a" });
		assert.deepEqual(await __testing.consumeResetCredit(headers, "credit-a", "redeem-a"), {
			outcome: "reset",
			windowsReset: 2,
		});
		assert.deepEqual(body, {
			credit_id: "credit-a",
			redeem_request_id: "redeem-a",
			account_id: "account-a",
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
