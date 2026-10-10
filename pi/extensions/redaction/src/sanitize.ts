import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent, ImageContent, JsonValue } from "@earendil-works/pi-ai";
import type { ToolResultEvent, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "./contracts.ts";

export const CENSORED = "[REDACTION_UNAVAILABLE: protected content withheld]";
export const BINARY_WITHHELD = "[Protected binary/image content withheld; text-only redaction]";
export type TextFilter = (text: string) => string;
const binaryField = /^(?:data|textSignature|thinkingSignature|thoughtSignature)$/i;

/** Tool-owned JSON only: never apply this generic walker to provider payloads. */
export function sanitizeJson(value: unknown, text: TextFilter, seen?: Set<object>, depth = 0, argumentValuesOnly = false): JsonValue {
  if (depth > 100) throw new Error("Unsupported protected data");
  if (typeof value === "string") return text(value);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value !== "object" || !value || seen?.has(value)) throw new Error("Unsupported protected data");
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Unsupported protected data");
  // Primitive tool fields need no cycle-tracking allocation. Object clones remain isolated.
  seen ??= new Set<object>();
  seen.add(value);
  try {
    if (array) return (value as unknown[]).map(item => sanitizeJson(item, text, seen, depth + 1, argumentValuesOnly));
    const output: Record<string, JsonValue> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      const safeKey = argumentValuesOnly ? key : text(key);
      if (Object.hasOwn(output, safeKey)) throw new Error("Ambiguous protected data");
      output[safeKey] = !argumentValuesOnly && binaryField.test(key) ? BINARY_WITHHELD : sanitizeJson(item, text, seen, depth + 1, argumentValuesOnly);
    }
    return output;
  } finally { seen.delete(value); }
}
function content(value: string | (TextContent | ImageContent)[], text: TextFilter): string | TextContent[] {
  if (typeof value === "string") return text(value);
  return value.map(block => block.type === "text" && !block.textSignature ? { type: "text", text: text(block.text) } : { type: "text", text: BINARY_WITHHELD });
}
export function sanitizeToolResult(event: ToolResultEvent, text: TextFilter): ToolResultEventResult {
  const result: ToolResultEventResult = {
    content: content(event.content, text) as TextContent[],
    details: event.details === undefined ? null : sanitizeJson(event.details, text),
  };
  if (event.structuredContent !== undefined) result.structuredContent = sanitizeJson(event.structuredContent, text);
  result.isError = event.isError;
  if (event.usage) result.usage = event.usage;
  return result;
}
export function censoredToolResult(event: ToolResultEvent): ToolResultEventResult {
  // null replaces details: undefined would mean 'keep original' to Pi's runner.
  return { content: [{ type: "text", text: CENSORED }], details: null, structuredContent: null, isError: true, ...(event.usage ? { usage: event.usage } : {}) };
}
export function sanitizeMessages(messages: AgentMessage[], sources: ExtensionConfig["sources"], text: TextFilter): AgentMessage[] {
  return messages.map(message => {
    switch (message.role) {
      case "user":
        return sources.userMessages ? { ...message, content: content(message.content, text) } : message;
      case "system":
        if (!sources.systemPrompt) return message;
        return {
          ...message, content: content(message.content, text) as string | TextContent[],
          ...(message.sections ? { sections: Object.fromEntries(Object.entries(message.sections).map(([key, value]) => [key, value === null ? null : text(value)])) } : {}),
          ...(message.toolsAdded ? { toolsAdded: message.toolsAdded.map(tool => ({ ...tool, description: text(tool.description) })) } : {}),
        };
      case "toolResult":
        if (!sources.toolResults) return message;
        return { ...message, content: content(message.content, text) as TextContent[], details: message.details === undefined ? undefined : sanitizeJson(message.details, text) };
      case "assistant":
        if (!sources.toolResults) return message;
        return { ...message, content: message.content.map(block => {
          // Opaque/signed provider blocks must round-trip unchanged, not be corrupted.
          if (block.type === "text") return block.textSignature ? block : { ...block, text: text(block.text) };
          if (block.type === "thinking") return block.thinkingSignature || block.redacted ? block : { ...block, thinking: text(block.thinking) };
          return block.thoughtSignature ? block : { ...block, arguments: sanitizeJson(block.arguments, text, new Set(), 0, true) as typeof block.arguments };
        }) };
      case "bashExecution":
        return sources.toolResults ? { ...message, command: text(message.command), output: text(message.output), ...(message.fullOutputPath ? { fullOutputPath: text(message.fullOutputPath) } : {}) } : message;
      case "custom":
        return sources.toolResults ? { ...message, content: content(message.content, text), details: message.details === undefined ? undefined : sanitizeJson(message.details, text) } : message;
      case "branchSummary":
      case "compactionSummary":
        return sources.toolResults ? { ...message, summary: text(message.summary) } : message;
      default:
        // New/third-party message roles have no audited source classification.
        if (sources.toolResults) throw new Error("Unsupported protected message");
        return message;
    }
  });
}
/** A complete safe transcript fallback avoids retaining unsafe IDs or opaque content on failure. */
export function censoredMessages(messages: AgentMessage[] = [], preserveDirectUser = false): AgentMessage[] {
  const users = preserveDirectUser ? messages.filter(message => message.role === "user") : [];
  return [{ role: "system", content: CENSORED, timestamp: 0 }, ...users, { role: "user", content: CENSORED, timestamp: 0 }];
}
