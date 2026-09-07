import type { AssistantMessage, Context, Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { COMMAND_CODE_MODELS } from "../src/catalogue.ts";

export const target: Model<string> = COMMAND_CODE_MODELS[0];
export function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", provider: "openai-codex", api: "openai-codex-responses", model: "gpt-5.4",
    content, stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}
export function sameTarget(content: AssistantMessage["content"]): AssistantMessage {
  return assistant(content, { provider: target.provider, api: target.api, model: target.id });
}
export function call(id = "call_synthetic|fc_synthetic"): ToolCall {
  return { type: "toolCall", id, name: "lookup", arguments: { query: "synthetic" },
    thoughtSignature: "SIGNATURE_SENTINEL", namespace: "NAMESPACE_SENTINEL" };
}
export function result(id = "call_synthetic|fc_synthetic", text = "synthetic result"): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "lookup", content: [{ type: "text", text }], isError: false, timestamp: 1 };
}
export const nextUser: Context["messages"][number] = { role: "user", content: "synthetic next", timestamp: 1 };
export function handoff(): Context {
  return { messages: [
    { role: "user", content: "synthetic start", timestamp: 1 },
    assistant([{ type: "thinking", thinking: "synthetic reasoning", thinkingSignature: "SIGNATURE_SENTINEL" }, call()], { stopReason: "toolUse" }),
    result(), assistant([{ type: "text", text: "synthetic done", textSignature: "SIGNATURE_SENTINEL" }]), nextUser,
  ] };
}
