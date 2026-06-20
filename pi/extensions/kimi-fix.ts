/**
 * kimi-fix — workaround for Moonshot Kimi K2.6 (and other MFJS / strict-mode
 * OpenAI-compatible providers) rejecting common JSON Schema patterns.
 *
 * ## Problem
 *
 * Two patterns in tool parameter schemas are rejected by Moonshot's MFJS
 * (Moonshot Flavored JSON Schema) validator at HTTP 400:
 *
 * 1. **`allOf` with conflicting `if` clauses** (the original bug):
 *    When a tool's `parameters` JSON Schema has two `if` keywords at the same
 *    path (typically because they sit as siblings inside an `allOf` array),
 *    MFJS's pre-flight normalizer merges them and bails with:
 *      "Conflict in schema definitions for key 'if'."
 *    MFJS also doesn't allow `if`/`then`/`else`/`allOf`/`oneOf`/`not`/`dependencies`
 *    at all, so even a single `if` would be rejected.
 *
 * 2. **Properties missing `type`** (the second bug we hit):
 *    When a property has `enum` (from `Type.Enum(...)` in TypeBox) or is the
 *    result of `Type.Any()` in TypeBox, the serialized JSON Schema lacks a
 *    `type` keyword. MFJS rejects this with:
 *      "At path 'properties.<name>': type is not defined"
 *    Concretely, the `pi-gemini-acp` package's `gemini_ask` tool defines
 *    `task: Type.Enum([...])`, which serializes to `{ enum: [...] }` with
 *    no `type: "string"`. Moonshot refuses the whole payload.
 *
 * ## Fix
 *
 * This extension runs on every `before_provider_request` for OpenAI-compatible
 * payloads. It applies two passes to each tool's `parameters` JSON Schema:
 *
 *   1. `stripConditionals` — removes the conditional/composition keywords
 *      (`allOf`, `if`, `then`, `else`, `not`, `oneOf`, `dependencies`,
 *      `dependentSchemas`, `dependentRequired`) that MFJS rejects.
 *   2. `inferMissingTypes` — walks the schema and adds a `type` to any
 *      property that lacks one. The inferred type is:
 *        - `"object"` if the property has `properties` or `additionalProperties`
 *        - `"array"`  if the property has `items`
 *        - `"string"` if the property has `enum` (TypeBox's Type.Enum produces
 *          string enums; numeric enums use a different TypeBox helper that
 *          already emits a `type`)
 *        - `"string"` as the default for any other property with no
 *          `type`/`anyOf`/`oneOf`/`$ref`/`const` discriminator
 *
 *      This is conservative: it preserves validation that already exists and
 *      only adds a `type` where MFJS would otherwise reject the schema. The
 *      default of `"string"` may be wrong for `Type.Any()` fields that the
 *      LLM fills with non-string values; if that causes runtime issues,
 *      the tool's `execute()` can still accept the value (pi doesn't
 *      re-validate after schema generation).
 *
 * The extension also runs at `tool_call` for the pi-subagents `subagent`
 * tool and validates the dynamic-fanout rules in user code:
 *   "if `expand` or `collect` is present, all three of `expand`, `parallel`,
 *   `collect` are required and `parallel` must be the object shape."
 *
 * For providers that use a different payload shape (Anthropic, Google) the
 * rewriter is a no-op — those providers accept `if/then/else` and the
 * other keywords, so we leave the schema untouched.
 *
 * ## Scope
 *
 * Generic — works for any tool that uses these JSON Schema features, not
 * just `subagent` or `gemini_ask`.
 *
 * ## Usage
 *
 *   pi -e ~/.pi/agent/extensions/kimi-fix.ts
 *
 * Or auto-load by dropping into ~/.pi/agent/extensions/ and running /reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** JSON Schema keywords that Moonshot MFJS / strict-mode providers reject. */
const STRIPPED_KEYWORDS = new Set([
	"allOf",
	"if",
	"then",
	"else",
	"not",
	"oneOf",
	"dependencies",
	"dependentSchemas",
	"dependentRequired",
]);

/** Walk a JSON Schema node and return a new node with the rejected keywords removed. */
function stripConditionals(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map(stripConditionals);
	}
	if (node && typeof node === "object") {
		const obj = node as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			if (STRIPPED_KEYWORDS.has(key)) continue;
			out[key] = stripConditionals(value);
		}
		return out;
	}
	return node;
}

/** Does this node have any way to constrain type? (type, anyOf, oneOf, $ref, const) */
function hasTypeDiscriminator(node: any): boolean {
	return (
		node &&
		typeof node === "object" &&
		!Array.isArray(node) &&
		(node.type !== undefined ||
			node.anyOf !== undefined ||
			node.oneOf !== undefined ||
			node.$ref !== undefined ||
			node.const !== undefined)
	);
}

/** Infer and inject a `type` keyword into schema nodes that lack one. Mutates and returns `node`. */
function inferMissingTypes(node: any): any {
	if (!node || typeof node !== "object") return node;
	if (Array.isArray(node)) {
		node.forEach(inferMissingTypes);
		return node;
	}

	// Object schemas: add `type: "object"` if missing, then recurse into properties.
	if (node.type === "object" || (node.properties !== undefined && !hasTypeDiscriminator(node))) {
		if (node.type === undefined && node.properties !== undefined) {
			node.type = "object";
		}
		if (node.properties) {
			for (const key of Object.keys(node.properties)) {
				inferMissingTypes(node.properties[key]);
			}
		}
		return node;
	}

	// Array schemas: ensure items have a type.
	if (node.type === "array" && node.items) {
		if (Array.isArray(node.items)) {
			node.items.forEach(inferMissingTypes);
		} else {
			inferMissingTypes(node.items);
		}
		return node;
	}

	// anyOf / oneOf: ensure each branch has a type, and recurse.
	for (const key of ["anyOf", "oneOf"] as const) {
		if (Array.isArray(node[key])) {
			node[key].forEach((branch: any) => {
				if (branch && typeof branch === "object" && !Array.isArray(branch)) {
					inferMissingTypes(branch);
				}
			});
		}
	}

	// Leaf property with no type discriminator: add `type: "string"`.
	if (!hasTypeDiscriminator(node)) {
		// Prefer "object" if the node looks like an inline object schema
		if (node.properties !== undefined || node.additionalProperties !== undefined) {
			node.type = "object";
		} else {
			node.type = "string";
		}
		return node;
	}

	// Has a type but no properties/items at this level — recurse into nested schemas
	// in case there are anyOf/oneOf items we missed (handled above) or items.
	if (node.items && !Array.isArray(node.items)) {
		inferMissingTypes(node.items);
	}

	return node;
}

type OpenAITool = {
	type?: string;
	function?: { name?: string; parameters?: unknown };
};

type OpenAIPayload = { tools?: OpenAITool[] };

function isOpenAIPayload(payload: unknown): payload is OpenAIPayload {
	if (!payload || typeof payload !== "object") return false;
	const tools = (payload as { tools?: unknown }).tools;
	return Array.isArray(tools);
}

/**
 * Validate the pi-subagents dynamic-fanout rules. Returns an error message
 * or null. The LLM still sees the `parallel: anyOf: [array, object]` base
 * discriminator; this catches the cross-field rules the stripped `allOf` used
 * to enforce.
 */
function validateChainParams(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const chain = (input as { chain?: unknown }).chain;
	if (!Array.isArray(chain)) return null;

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		if (!step || typeof step !== "object") continue;
		const s = step as Record<string, unknown>;
		const hasExpand = s.expand !== undefined;
		const hasCollect = s.collect !== undefined;
		if (!hasExpand && !hasCollect) continue;
		if (!hasExpand) {
			return `chain[${i}]: collect is present but expand is required (dynamic fanout requires all three of expand, parallel, collect)`;
		}
		if (!hasCollect) {
			return `chain[${i}]: expand is present but collect is required (dynamic fanout requires all three of expand, parallel, collect)`;
		}
		if (s.parallel === undefined) {
			return `chain[${i}]: expand and collect are present but parallel is required`;
		}
		if (Array.isArray(s.parallel)) {
			return `chain[${i}]: parallel must be an object (dynamic fanout template), not an array, when expand and collect are present`;
		}
	}
	return null;
}

export default function kimiFixExtension(pi: ExtensionAPI) {
	// Pass 1+2: strip conditional keywords, then infer missing `type` keywords
	// so Moonshot's MFJS validator accepts the schema. Mutates the OpenAI
	// request payload in place; downstream handlers and the actual API call
	// see the sanitized schema.
	pi.on("before_provider_request", (event) => {
		const payload = event.payload as unknown;
		if (!isOpenAIPayload(payload)) return;
		for (const tool of payload.tools) {
			if (tool?.type === "function" && tool.function?.parameters) {
				const params = tool.function.parameters as any;
				const stripped = stripConditionals(params);
				tool.function.parameters = inferMissingTypes(stripped);
			}
		}
		return payload;
	});

	// Runtime check for the pi-subagents dynamic-fanout rules (only needed
	// for the upstream `subagent` tool; the @gotgenes fork uses a different
	// shape and doesn't need this).
	pi.on("tool_call", (event) => {
		if (event.toolName !== "subagent") return;
		const err = validateChainParams(event.input);
		if (err) {
			return { block: true, reason: err };
		}
	});
}
