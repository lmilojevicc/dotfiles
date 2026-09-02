/*
 * Remote compaction behavior adapted from Alexis Gallagher's
 * pi-openai-server-compaction and @pi-zza/codex-native-compaction.
 *
 * MIT License — Copyright © 2026 Alexis Gallagher
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import {
	convertToLlm,
	sessionEntryToContextMessages,
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { isCanonicalBaseUrl, isCanonicalCodexModel, type RuntimeModel } from "./core.ts";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const COMPACTION_FEATURE = "remote_compaction_v2";
const RETAINED_USER_TOKEN_BUDGET = 20_000;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export type ResponseItem = { type: string; [key: string]: unknown };

export type ServerCompactionDetails = {
	version: 2;
	provider: "openai-responses-compaction";
	modelKey: string;
	replacementHistory: ResponseItem[];
};

type BranchEntry = SessionEntry & {
	details?: unknown;
	message?: Record<string, unknown>;
};

export type RequestShape = {
	tools?: unknown[];
	parallelToolCalls?: boolean;
	toolChoice?: unknown;
	serviceTier?: string;
	reasoning?: Record<string, unknown>;
	text?: Record<string, unknown>;
};

type CanonicalCodexAuth = {
	token: string;
	accountId: string;
	baseUrl: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function modelKey(model: RuntimeModel): string {
	return `${model.provider}:${model.api}:${model.id ?? ""}`;
}

function extractAccountId(token: string): string | undefined {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as unknown;
		const auth = isRecord(payload) ? payload[JWT_CLAIM_PATH] : undefined;
		return isRecord(auth) ? stringValue(auth.chatgpt_account_id) : undefined;
	} catch {
		return undefined;
	}
}

async function resolveCanonicalCodexAuth(ctx: ExtensionContext): Promise<CanonicalCodexAuth> {
	const resolved = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const token = resolved?.auth.apiKey;
	const baseUrl = resolved?.auth.baseUrl ?? CODEX_BASE_URL;
	const accountId = token ? extractAccountId(token) : undefined;
	if (!token || !accountId || !isCanonicalBaseUrl(baseUrl, true)) {
		throw new Error("Canonical OpenAI Codex subscription auth is required for server-side compaction.");
	}
	return { token, accountId, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function responseEndpoint(baseUrl: string): string {
	if (baseUrl.endsWith("/codex/responses")) return baseUrl;
	if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
	return `${baseUrl}/codex/responses`;
}

function contentItems(value: unknown, output = false): ResponseItem[] {
	if (typeof value === "string") {
		return value ? [{ type: output ? "output_text" : "input_text", text: value }] : [];
	}
	if (!Array.isArray(value)) return [];
	return value.flatMap((part): ResponseItem[] => {
		if (!isRecord(part)) return [];
		if (typeof part.text === "string") {
			return [{ type: output ? "output_text" : "input_text", text: part.text }];
		}
		if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
			return [{ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` }];
		}
		return [];
	});
}

function parseReasoningSignature(value: unknown): ResponseItem | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) && parsed.type === "reasoning" ? clone(parsed as ResponseItem) : undefined;
	} catch {
		return undefined;
	}
}

export function messageToResponseItems(message: Record<string, unknown>): ResponseItem[] {
	if (message.role === "user") {
		const content = contentItems(message.content);
		return content.length ? [{ type: "message", role: "user", content }] : [];
	}
	if (message.role === "toolResult") {
		const callId = stringValue(message.toolCallId)?.split("|", 1)[0];
		if (!callId) return [];
		const output = typeof message.content === "string" ? message.content : contentItems(message.content);
		return [{ type: "function_call_output", call_id: callId, output }];
	}
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];

	const items: ResponseItem[] = [];
	let text = "";
	let phase: string | undefined;
	const flushText = () => {
		if (!text) return;
		items.push({
			type: "message",
			role: "assistant",
			content: [{ type: "output_text", text }],
			...(phase === "commentary" || phase === "final_answer" ? { phase } : {}),
		});
		text = "";
	};
	for (const block of message.content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			if (!phase && typeof block.textSignature === "string") {
				try {
					const signature = JSON.parse(block.textSignature) as unknown;
					if (isRecord(signature) && typeof signature.phase === "string") phase = signature.phase;
				} catch { /* older signatures do not carry a phase */ }
			}
			text += block.text;
			continue;
		}
		if (block.type === "thinking") {
			flushText();
			const reasoning = parseReasoningSignature(block.thinkingSignature);
			if (reasoning) items.push(reasoning);
			continue;
		}
		if (block.type === "toolCall") {
			flushText();
			const callId = String(block.id ?? "").split("|", 1)[0];
			if (callId) {
				items.push({
					type: "function_call",
					name: String(block.name ?? ""),
					call_id: callId,
					arguments: JSON.stringify(block.arguments ?? {}),
				});
			}
		}
	}
	flushText();
	return items;
}

export function messagesToResponseItems(messages: Record<string, unknown>[]): ResponseItem[] {
	return messages.flatMap(messageToResponseItems);
}

function responseMessageText(item: ResponseItem): string {
	if (item.type !== "message" || !Array.isArray(item.content)) return "";
	return item.content
		.filter(isRecord)
		.map((part) => typeof part.text === "string" ? part.text : "")
		.join("");
}

function retainRecentUserMessages(items: ResponseItem[]): ResponseItem[] {
	let remainingCharacters = RETAINED_USER_TOKEN_BUDGET * 4;
	const retained: ResponseItem[] = [];
	for (const item of [...items].reverse()) {
		if (item.type !== "message" || item.role !== "user" || remainingCharacters <= 0) continue;
		const textLength = responseMessageText(item).length;
		if (textLength <= remainingCharacters) {
			retained.push(clone(item));
			remainingCharacters -= textLength;
		}
	}
	return retained.reverse();
}

function detailsFrom(value: unknown): ServerCompactionDetails | undefined {
	if (!isRecord(value)) return undefined;
	const details = isRecord(value.codexEnhancedCompaction) ? value.codexEnhancedCompaction : value;
	if (!isRecord(details)
		|| details.version !== 2
		|| details.provider !== "openai-responses-compaction"
		|| typeof details.modelKey !== "string"
		|| !Array.isArray(details.replacementHistory)) return undefined;
	const replacementHistory = details.replacementHistory.filter((item): item is ResponseItem => isRecord(item) && typeof item.type === "string");
	if (!replacementHistory.some((item) => item.type === "compaction" && stringValue(item.encrypted_content))) return undefined;
	return {
		version: 2,
		provider: "openai-responses-compaction",
		modelKey: details.modelKey,
		replacementHistory: clone(replacementHistory),
	};
}

function assistantMatchesModel(message: Record<string, unknown>, model: RuntimeModel): boolean {
	return message.provider === model.provider && message.api === model.api && message.model === model.id;
}

function entryToLlmMessages(entry: BranchEntry): Record<string, unknown>[] {
	return convertToLlm(sessionEntryToContextMessages(entry) as never) as unknown as Record<string, unknown>[];
}

function entriesToLlmMessages(entries: BranchEntry[]): Record<string, unknown>[] {
	return entries.flatMap(entryToLlmMessages);
}

export function reconstructCompactedHistory(
	branchEntries: BranchEntry[],
	model: RuntimeModel,
): ResponseItem[] | undefined {
	let compactionIndex = -1;
	let details: ServerCompactionDetails | undefined;
	for (let index = 0; index < branchEntries.length; index += 1) {
		const entry = branchEntries[index];
		if (entry?.type !== "compaction") continue;
		compactionIndex = index;
		details = detailsFrom(entry.details);
	}
	if (!details || compactionIndex < 0 || details.modelKey !== modelKey(model)) return undefined;

	const history = clone(details.replacementHistory);
	let pending: ResponseItem[] = [];
	for (const entry of branchEntries.slice(compactionIndex + 1)) {
		const items = messagesToResponseItems(entryToLlmMessages(entry));
		if (entry.type === "message" && entry.message?.role === "assistant") {
			if (assistantMatchesModel(entry.message, model)) history.push(...pending, ...items);
			pending = [];
		} else {
			pending.push(...items);
		}
	}
	return [...history, ...pending];
}

export function applyCompactedHistory(payload: unknown, history: ResponseItem[]): Record<string, unknown> | undefined {
	if (!isRecord(payload)) return undefined;
	const next: Record<string, unknown> = { ...payload, input: clone(history) };
	delete next.messages;
	delete next.previous_response_id;
	return next;
}

export function captureRequestShape(payload: unknown): RequestShape | undefined {
	if (!isRecord(payload)) return undefined;
	return {
		...(typeof payload.parallel_tool_calls === "boolean" ? { parallelToolCalls: payload.parallel_tool_calls } : {}),
		...(payload.tool_choice !== undefined ? { toolChoice: clone(payload.tool_choice) } : {}),
		...(typeof payload.service_tier === "string" ? { serviceTier: payload.service_tier } : {}),
		...(isRecord(payload.reasoning) ? { reasoning: clone(payload.reasoning) } : {}),
		...(isRecord(payload.text) ? { text: clone(payload.text) } : {}),
	};
}

function responseTool(tool: ToolInfo): ResponseItem {
	return {
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: clone(tool.parameters),
		strict: false,
	};
}

export function withCurrentActiveTools(
	pi: Pick<ExtensionAPI, "getActiveTools" | "getAllTools">,
	shape?: RequestShape,
): RequestShape {
	const active = new Set(pi.getActiveTools());
	return {
		...shape,
		tools: pi.getAllTools().filter((tool) => active.has(tool.name)).map(responseTool),
	};
}

function messageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(isRecord).map((part) => {
		if (typeof part.text === "string") return part.text;
		if (typeof part.thinking === "string") return `[reasoning]\n${part.thinking}`;
		if (part.type === "toolCall") {
			return `[tool call: ${String(part.name ?? "unknown")}]\n${JSON.stringify(part.arguments ?? {})}`;
		}
		if (part.type === "image") return "[image attachment]";
		return "";
	}).filter(Boolean).join("\n");
}

async function generatePortableSummary(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	model: RuntimeModel,
	messages: Record<string, unknown>[],
): Promise<{ summary: string; usage?: unknown }> {
	const conversation = messages
		.map((message) => `${String(message.role ?? "message").toUpperCase()}: ${messageText(message)}`)
		.filter((line) => !line.endsWith(": "))
		.join("\n\n");
	const extra = event.customInstructions ? `\n\nAdditional instructions:\n${event.customInstructions}` : "";
	const response = await ctx.modelRegistry.complete(model as never, {
		messages: [{
			role: "user",
			content: [{
				type: "text",
				text: `Summarize this conversation for continuation. Preserve goals, decisions, important facts, file paths, open questions, and next steps. Be concise but complete.${extra}\n\n<conversation>\n${conversation}\n</conversation>`,
			}],
			timestamp: Date.now(),
		}],
	}, { maxTokens: 4096, signal: event.signal, cacheRetention: "none" });
	const summary = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!summary) throw new Error("Server compaction portable summary was empty.");
	return { summary, usage: response.usage };
}

function parseSseEvents(text: string): unknown[] {
	return text.replace(/\r\n/g, "\n").split("\n\n").flatMap((block) => {
		const data = block.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (!data || data === "[DONE]") return [];
		try { return [JSON.parse(data) as unknown]; } catch { return []; }
	});
}

export function extractCompactionItem(events: unknown[]): ResponseItem {
	let completed = false;
	const items: ResponseItem[] = [];
	for (const event of events) {
		if (!isRecord(event)) continue;
		if (event.type === "error") throw new Error(stringValue(event.message) ?? "OpenAI server compaction failed.");
		if (event.type === "response.failed") throw new Error("OpenAI server compaction response failed.");
		if (event.type === "response.output_item.done" && isRecord(event.item)
			&& event.item.type === "compaction" && stringValue(event.item.encrypted_content)) {
			items.push(clone(event.item as ResponseItem));
		}
		if (event.type === "response.completed") completed = true;
	}
	if (!completed || items.length !== 1) {
		throw new Error(`OpenAI server compaction returned ${items.length} usable encrypted item(s).`);
	}
	return items[0] as ResponseItem;
}

async function requestServerCompaction(
	ctx: ExtensionContext,
	model: RuntimeModel,
	input: ResponseItem[],
	shape: RequestShape | undefined,
	signal: AbortSignal,
): Promise<ResponseItem[]> {
	const auth = await resolveCanonicalCodexAuth(ctx);
	const response = await fetch(responseEndpoint(auth.baseUrl), {
		method: "POST",
		headers: {
			accept: "text/event-stream",
			"content-type": "application/json",
			authorization: `Bearer ${auth.token}`,
			"chatgpt-account-id": auth.accountId,
			"OpenAI-Beta": "responses=experimental",
			"x-codex-beta-features": COMPACTION_FEATURE,
			originator: "pi",
		},
		body: JSON.stringify({
			model: model.id,
			instructions: ctx.getSystemPrompt(),
			input: [...input, { type: "compaction_trigger" }],
			tools: shape?.tools ?? [],
			parallel_tool_calls: shape?.parallelToolCalls ?? true,
			tool_choice: shape?.toolChoice ?? "auto",
			...(shape?.serviceTier ? { service_tier: shape.serviceTier } : {}),
			stream: true,
			store: false,
			include: ["reasoning.encrypted_content"],
			...(shape?.reasoning ? { reasoning: shape.reasoning } : {}),
			...(shape?.text ? { text: shape.text } : {}),
		}),
		signal,
	});
	if (!response.ok) {
		const message = await response.text().catch(() => "");
		throw new Error(`OpenAI server compaction failed (${response.status}): ${message || response.statusText}`);
	}
	const compactionItem = extractCompactionItem(parseSseEvents(await response.text()));
	return [...retainRecentUserMessages(input), compactionItem];
}

export async function compactOnServer(
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	shape?: RequestShape,
): Promise<CompactionResult | undefined> {
	const model = ctx.model as RuntimeModel | undefined;
	if (!isCanonicalCodexModel(model) || !model.id) return undefined;
	const entries = event.branchEntries as BranchEntry[];
	const messages = entriesToLlmMessages(entries);
	const input = reconstructCompactedHistory(entries, model) ?? messagesToResponseItems(messages);
	try {
		// Compact remotely first so an unsupported/failed endpoint does not also spend
		// a second model call on a portable summary before Pi performs local fallback.
		const replacementHistory = await requestServerCompaction(ctx, model, input, shape, event.signal);
		const portable = await generatePortableSummary(event, ctx, model, messages);
		return {
			summary: portable.summary,
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			usage: portable.usage as never,
			details: {
				codexEnhancedCompaction: {
					version: 2,
					provider: "openai-responses-compaction",
					modelKey: modelKey(model),
					replacementHistory,
				} satisfies ServerCompactionDetails,
			},
		};
	} catch (error) {
		if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
		// Returning undefined delegates to Pi's normal local compaction.
		return undefined;
	}
}
