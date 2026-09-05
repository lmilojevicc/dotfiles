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
