import assert from "node:assert/strict";
import test from "node:test";
import {
	applyCompactedHistory,
	compactOnServer,
	extractCompactionItem,
	reconstructCompactedHistory,
	withCurrentActiveTools,
} from "../compaction.ts";

function token(accountId: string): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})).toString("base64url");
	return `header.${payload}.signature`;
}

const model = {
	id: "gpt-5.4",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://chatgpt.com/backend-api",
};

const compactionItem = { type: "compaction", encrypted_content: "opaque-secret" };

function event(entries: unknown[]) {
	return {
		branchEntries: entries,
		preparation: { firstKeptEntryId: "kept", tokensBefore: 123 },
		signal: new AbortController().signal,
	} as never;
}

function context(entries: unknown[], complete = async () => ({
	content: [{ type: "text", text: "portable summary" }],
	usage: undefined,
})) {
	return {
		model,
		getSystemPrompt: () => "system prompt",
		sessionManager: { getBranch: () => entries },
		modelRegistry: {
			getProviderAuth: async () => ({
				auth: { apiKey: token("account-a"), baseUrl: "https://chatgpt.com/backend-api" },
			}),
			complete,
		},
	} as never;
}

test("extracts exactly one encrypted compaction item from a completed response", () => {
	assert.deepEqual(extractCompactionItem([
		{ type: "response.output_item.done", item: compactionItem },
		{ type: "response.completed", response: {} },
	]), compactionItem);
	assert.throws(() => extractCompactionItem([
		{ type: "response.output_item.done", item: { type: "compaction", encrypted_content: "" } },
		{ type: "response.completed", response: {} },
	]), /0 usable encrypted item/);
});

test("replays persisted opaque history instead of Pi's placeholder summary", () => {
	const entries = [{
		type: "compaction",
		id: "compact-1",
		details: {
			codexEnhancedCompaction: {
				version: 2,
				provider: "openai-responses-compaction",
				modelKey: "openai-codex:openai-codex-responses:gpt-5.4",
				replacementHistory: [compactionItem],
			},
		},
	}, {
		type: "message",
		id: "user-1",
		message: { role: "user", content: [{ type: "text", text: "continue" }] },
	}, {
		type: "message",
		id: "assistant-1",
		message: {
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.4",
			content: [{ type: "text", text: "done" }],
		},
	}];
	const history = reconstructCompactedHistory(entries, model);
	assert.deepEqual(history, [
		compactionItem,
		{ type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
	]);
	assert.deepEqual(applyCompactedHistory({ messages: ["placeholder"], previous_response_id: "old", model: "gpt-5.4" }, history!), {
		model: "gpt-5.4",
		input: history,
	});
	assert.equal(reconstructCompactedHistory(entries, { ...model, id: "other" }), undefined);
});

test("drops pending context when an assistant response came from a different API", () => {
	const entries = [{
		type: "compaction",
		id: "compact-1",
		details: {
			codexEnhancedCompaction: {
				version: 2,
				provider: "openai-responses-compaction",
				modelKey: "openai-codex:openai-codex-responses:gpt-5.4",
				replacementHistory: [compactionItem],
			},
		},
	}, {
		type: "message",
		id: "user-drop",
		message: { role: "user", content: [{ type: "text", text: "drop me" }] },
	}, {
		type: "message",
		id: "assistant-other-api",
		message: {
			role: "assistant",
			provider: "openai-codex",
			api: "openai-responses",
			model: "gpt-5.4",
			content: [{ type: "text", text: "also dropped" }],
		},
	}];
	assert.deepEqual(reconstructCompactedHistory(entries as never, model), [compactionItem]);
});

test("projects every context-producing entry through Pi conversion during opaque replay", () => {
	const entries = [{
		type: "compaction",
		id: "compact-1",
		details: {
			codexEnhancedCompaction: {
				version: 2,
				provider: "openai-responses-compaction",
				modelKey: "openai-codex:openai-codex-responses:gpt-5.4",
				replacementHistory: [compactionItem],
			},
		},
	}, {
		type: "custom_message",
		id: "custom-entry",
		customType: "notice",
		content: "custom entry",
		display: false,
		timestamp: "2030-01-01T00:00:00Z",
	}, {
		type: "branch_summary",
		id: "branch-entry",
		fromId: "old-branch",
		summary: "branch context",
		timestamp: "2030-01-01T00:00:01Z",
	}, {
		type: "message",
		id: "bash-entry",
		message: { role: "bashExecution", command: "pwd", output: "/tmp", timestamp: 1 },
	}, {
		type: "message",
		id: "custom-role-entry",
		message: { role: "custom", customType: "runtime", content: "custom role", display: false, timestamp: 2 },
	}, {
		type: "message",
		id: "assistant-tool",
		message: {
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.4",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
		},
	}, {
		type: "message",
		id: "tool-result",
		message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "tool output" }] },
	}, {
		type: "message",
		id: "assistant-final",
		message: {
			role: "assistant",
			provider: "openai-codex",
			api: "openai-codex-responses",
			model: "gpt-5.4",
			content: [{ type: "text", text: "done" }],
		},
	}];
	const history = reconstructCompactedHistory(entries as never, model)!;
	assert.equal(history[0]?.type, "compaction");
	assert.match(JSON.stringify(history), /custom entry/);
	assert.match(JSON.stringify(history), /branch context/);
	assert.match(JSON.stringify(history), /Ran `pwd`/);
	assert.match(JSON.stringify(history), /custom role/);
	assert.ok(history.some((item) => item.type === "function_call_output"));
	assert.equal((history.at(-1) as { role?: unknown }).role, "assistant");
});

test("builds OpenAI tool schemas from the current active tools without a prior request", () => {
	const shape = withCurrentActiveTools({
		getActiveTools: () => ["read"],
		getAllTools: () => [{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		}, {
			name: "bash",
			description: "Run a command",
			parameters: { type: "object" },
		}],
	} as never);
	assert.deepEqual(shape.tools, [{
		type: "function",
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		strict: false,
	}]);
});

test("server compaction persists opaque replay details and sends a v2 trigger", async () => {
	const originalFetch = globalThis.fetch;
	let requestBody: Record<string, unknown> | undefined;
	let requestHeaders: Headers | undefined;
	globalThis.fetch = async (_input, init) => {
		requestBody = JSON.parse(String(init?.body));
		requestHeaders = new Headers(init?.headers);
		const sse = [
			`data: ${JSON.stringify({ type: "response.output_item.done", item: compactionItem })}`,
			`data: ${JSON.stringify({ type: "response.completed", response: {} })}`,
			"data: [DONE]",
		].join("\n\n");
		return new Response(sse, { status: 200 });
	};
	const entries = [{
		type: "message",
		id: "user-1",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	}, {
		type: "custom_message",
		id: "custom-entry",
		customType: "notice",
		content: "custom entry",
		display: false,
		timestamp: "2030-01-01T00:00:00Z",
	}, {
		type: "branch_summary",
		id: "branch-entry",
		fromId: "old-branch",
		summary: "branch context",
		timestamp: "2030-01-01T00:00:01Z",
	}, {
		type: "message",
		id: "bash-entry",
		message: { role: "bashExecution", command: "pwd", output: "/tmp", timestamp: 1 },
	}, {
		type: "message",
		id: "custom-role-entry",
		message: { role: "custom", customType: "runtime", content: "custom role", display: false, timestamp: 2 },
	}];
	try {
		const result = await compactOnServer(event(entries), context(entries), {
			tools: [{ type: "function", name: "read" }],
			parallelToolCalls: true,
			serviceTier: "priority",
		});
		assert.equal(result?.summary, "portable summary");
		assert.equal(result?.firstKeptEntryId, "kept");
		assert.equal((requestBody?.input as Array<{ type?: unknown }>).at(-1)?.type, "compaction_trigger");
		assert.deepEqual(requestBody?.tools, [{ type: "function", name: "read" }]);
		assert.equal(requestBody?.service_tier, "priority");
		assert.match(requestHeaders?.get("x-codex-beta-features") ?? "", /remote_compaction_v2/);
		const details = (result?.details as any)?.codexEnhancedCompaction;
		assert.equal(details?.version, 2);
		assert.equal(details?.provider, "openai-responses-compaction");
		assert.equal(details?.modelKey, "openai-codex:openai-codex-responses:gpt-5.4");
		assert.match(JSON.stringify(details?.replacementHistory), /custom entry/);
		assert.match(JSON.stringify(details?.replacementHistory), /branch context/);
		assert.match(JSON.stringify(details?.replacementHistory), /Ran `pwd`/);
		assert.match(JSON.stringify(details?.replacementHistory), /custom role/);
		assert.deepEqual(details?.replacementHistory.at(-1), compactionItem);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("remote failure returns undefined without issuing a redundant portable-summary request", async () => {
	const originalFetch = globalThis.fetch;
	let summaryRequests = 0;
	globalThis.fetch = async () => new Response("unsupported", { status: 400 });
	const entries = [{
		type: "message",
		id: "user-1",
		message: { role: "user", content: [{ type: "text", text: "hello" }] },
	}];
	try {
		assert.equal(await compactOnServer(event(entries), context(entries, async () => {
			summaryRequests += 1;
			return { content: [{ type: "text", text: "portable summary" }], usage: undefined };
		})), undefined);
		assert.equal(summaryRequests, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("aborted remote compaction is not converted into local fallback", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_input, init) => {
		if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
		throw new Error("expected an aborted signal");
	};
	const controller = new AbortController();
	controller.abort();
	const abortedEvent = {
		...event([{
			type: "message",
			id: "user-1",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		}]),
		signal: controller.signal,
	} as never;
	try {
		await assert.rejects(compactOnServer(abortedEvent, context([])), { name: "AbortError" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});
