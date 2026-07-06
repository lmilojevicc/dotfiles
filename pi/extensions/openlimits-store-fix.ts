/**
 * openlimits-store-fix — strips server-issued item IDs from
 * openai-responses payloads routed through OpenLimits.
 *
 * ## Problem
 *
 * `before_provider_request` fires with `payload: unknown` and no model
 * metadata, so this extension inspects the payload to decide whether to act.
 *
 * The OpenAI Responses API carries forward item IDs (e.g. `rs_xxx` for
 * reasoning, `fc_xxx` for function calls, `msg_xxx` for assistant messages)
 * between turns. By default, those IDs are only valid when `store: true`
 * is set on the upstream request — the API keeps the item state in a
 * server-side store keyed by response ID.
 *
 * OpenLimits proxies OpenAI Responses and **requires `store: false`** for
 * every request (because they do not persist state server-side). When a
 * pi session goes multi-turn, the next request replay includes the
 * previous turn's reasoning items as JSON-serialized objects with the
 * original `id` field still in place. OpenLimits forwards that to
 * upstream OpenAI, and the API rejects it with HTTP 404:
 *
 *     Item with id 'rs_0ed1...' not found. Items are not persisted
 *     when `store` is set to false.
 *
 * This bites every model in the `openai-responses` pipeline that emits
 * reasoning — GPT-5.6 Sol/Terra/Luna, GPT-5.5/5.4, GPT-5.3 Codex Spark,
 * and any future reasoning-capable model that goes through the same
 * OpenLimits endpoint family.
 *
 * ## Fix
 *
 * When the outgoing payload is shaped like a Responses API request and
 * targets a known OpenLimits reasoning model, strip the `id` fields from
 * every `function_call`, `message`, and `reasoning` item in `input`.
 * Without an `id`, the upstream API treats each item as new content
 * rather than a reference to persisted state, so the request goes through.
 *
 * Also explicitly sets `store: false` to make the intent unambiguous (the
 * OpenAI default is already `false`, but spelling it out matches OpenLimits'
 * documented contract and avoids any chance of an SDK default change).
 *
 * ## Scope
 *
 * Only touches `openai-responses` payloads. Leaves `anthropic-messages`,
 * `openai-completions`, and any other api path untouched. Only matches
 * against a small allowlist of model IDs to avoid accidentally
 * rewriting payloads for non-OpenLimits providers that happen to share
 * the same api path (e.g. native `openai` provider where `store: true`
 * may be desirable).
 *
 * ## Usage
 *
 * Drop into ~/.pi/agent/extensions/ and run `/reload`, or start with:
 *   pi -e ~/.pi/agent/extensions/openlimits-store-fix.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Model IDs we know go through OpenLimits' Responses proxy with `store:false`.
// Add new IDs here as OpenLimits onboards them.
const OPENLIMITS_RESPONSES_MODELS = new Set<string>([
	"openai/gpt-5.6-sol",
	"openai/gpt-5.6-terra",
	"openai/gpt-5.6-luna",
	"openai/gpt-5.5",
	"openai/gpt-5.4",
	"openai/gpt-5.4-mini",
	"openai/gpt-5.3-codex-spark",
	"anthropic/fable-5",
]);

type ResponsesInputItem =
	| { type: "message"; id?: string; [k: string]: unknown }
	| { type: "function_call"; id?: string; call_id?: string; [k: string]: unknown }
	| { type: "function_call_output"; [k: string]: unknown }
	| { type: "reasoning"; id?: string; [k: string]: unknown }
	| { type: string; [k: string]: unknown };

interface ResponsesPayload {
	model?: string;
	input?: ResponsesInputItem[];
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	[key: string]: unknown;
}

/**
 * Returns true if the payload looks like an OpenAI Responses API request.
 * Detection is structural: must have a string `model` and an `input` array,
 * and must NOT have any field that's characteristic of the Chat Completions
 * payload (which also has `messages`, not `input`).
 */
function isResponsesPayload(p: unknown): p is ResponsesPayload {
	if (typeof p !== "object" || p === null) return false;
	const obj = p as Record<string, unknown>;
	if (typeof obj.model !== "string") return false;
	if (!Array.isArray(obj.input)) return false;
	if (Array.isArray(obj.messages)) return false; // chat completions
	return true;
}

/** Strip `id` from any item type that carries one. Returns a new array. */
function stripItemIds(items: ResponsesInputItem[]): ResponsesInputItem[] {
	return items.map((item) => {
		if (item && typeof item === "object" && typeof item.type === "string") {
			// Only modify items that carry the client-resend `id` field.
			// function_call_output is keyed by `call_id`, not `id`, and the
			// upstream API uses call_id to match outputs to calls regardless
			// of store mode — leave it alone.
			if (
				item.type === "message" ||
				item.type === "function_call" ||
				item.type === "reasoning"
			) {
				if ("id" in item) {
					const { id: _id, ...rest } = item as { id: string; [k: string]: unknown };
					return rest as ResponsesInputItem;
				}
			}
		}
		return item;
	});
}

export default function openlimitsStoreFix(pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, _ctx) => {
		const payload = event.payload;
		if (!isResponsesPayload(payload)) return; // not Responses API; leave alone

		const modelId = payload.model;
		if (!modelId || !OPENLIMITS_RESPONSES_MODELS.has(modelId)) return;

		const original = payload.input;
		if (!Array.isArray(original) || original.length === 0) {
			// Nothing to strip, but still set store explicitly.
			return { ...payload, store: false };
		}

		const stripped = stripItemIds(original);
		return { ...payload, input: stripped, store: false };
	});
}
