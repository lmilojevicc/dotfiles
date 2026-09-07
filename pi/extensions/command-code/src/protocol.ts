import { createHash } from "node:crypto";
import { transformMessagesPi0851 } from "./pi-0851-transform-messages.ts";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { GATEWAY_DEFAULT_MAX_TOKENS } from "./catalogue.ts";

export interface CommandCodePayload {
  config: {
    workingDir: string;
    date: string;
    environment: NodeJS.Platform;
    structure: readonly string[];
    isGitRepo: false;
    currentBranch: "";
    mainBranch: "";
    gitStatus: "";
    recentCommits: readonly string[];
  };
  memory: null;
  taste: null;
  skills: null;
  permissionMode: "standard";
  threadId?: string;
  mode: "agent";
  params: {
    model: string;
    messages: unknown[];
    tools: unknown[];
    system: string;
    max_tokens: number;
    stream: true;
    temperature?: number;
    reasoning_effort?: string;
  };
}

function wireUserBlocks(
  content: readonly { type: string; text?: string; data?: string; mimeType?: string }[],
  supportsImages: boolean,
): unknown[] {
  return content.map((part) => {
    if (part.type === "image") {
      return supportsImages
        ? { type: "image", image: `data:${part.mimeType};base64,${part.data}`, mimeType: part.mimeType }
        : { type: "text", text: "[Image omitted: the selected Command Code model is text-only.]" };
    }
    return { type: "text", text: part.text ?? "" };
  });
}

function portableToolCallId(id: string): string {
  // Hash the whole ID, not a sanitized/truncated prefix (Responses IDs can be
  // composite and very long). 192 digest bits keep IDs bounded and portable.
  return `call_${createHash("sha256").update(id).digest("hex").slice(0, 48)}`;
}

export function convertMessages(context: Context, model: Model<string>): unknown[] {
  const output: unknown[] = [];
  const pendingToolIds = new Set<string>();
  // The versioned Pi compatibility adapter preserves source history, downgrades
  // foreign thinking, drops failed turns and inserts missing error results.
  for (const message of transformMessagesPi0851(context.messages, model, portableToolCallId)) {
    if (message.role === "user") {
      pendingToolIds.clear();
      output.push({
        role: "user",
        content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : wireUserBlocks(message.content, model.input.includes("image")),
      });
    } else if (message.role === "assistant") {
      pendingToolIds.clear();
      const content: unknown[] = [];
      for (const part of message.content) {
        if (part.type === "thinking") {
          // The gateway has no encrypted/signature replay field. Never project
          // opaque redacted content or empty reasoning, even for the same model.
          if (!part.redacted && part.thinking.trim()) content.push({ type: "reasoning", text: part.thinking });
        } else if (part.type === "toolCall") {
          pendingToolIds.add(part.id);
          content.push({ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.arguments });
        } else if (part.text.trim()) content.push({ type: "text", text: part.text });
      }
      if (content.length) output.push({ role: "assistant", content });
    } else {
      // Discard unmatched/duplicate results, including results from omitted
      // failed calls. Do not invent successful assistant calls to retain them.
      if (!pendingToolIds.delete(message.toolCallId)) continue;
      output.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          output: { type: "text", value: message.content.map((part) => part.type === "text" ? part.text : "[image result]").join("\n") },
          isError: message.isError,
        }],
      });
    }
  }
  return output;
}

export function buildPayload(model: Model<string>, context: Context, options: SimpleStreamOptions = {}): CommandCodePayload {
  const mappedEffort = options.reasoning ? model.thinkingLevelMap?.[options.reasoning] : undefined;
  const maxTokens = Math.max(1, Math.min(options.maxTokens ?? GATEWAY_DEFAULT_MAX_TOKENS, model.maxTokens));
  const params: CommandCodePayload["params"] = {
    model: model.id,
    messages: convertMessages(context, model),
    tools: (context.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    system: context.systemPrompt ?? "",
    max_tokens: maxTokens,
    stream: true,
  };
  if (typeof options.temperature === "number") params.temperature = options.temperature;
  if (model.reasoning && typeof mappedEffort === "string") params.reasoning_effort = mappedEffort;

  const payload: CommandCodePayload = {
    // Command Code sends repository metadata here. Pi does not expose an
    // equivalent safe snapshot, so send the observed non-repository shape.
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().slice(0, 10),
      environment: process.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: "standard",
    mode: "agent",
    params,
  };
  if (options.sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.sessionId)) {
    payload.threadId = options.sessionId;
  }
  return payload;
}
