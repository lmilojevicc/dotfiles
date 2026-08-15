import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ProviderHeaders,
  type ProviderResponse,
  type SimpleStreamOptions,
  type StopReason,
  type ThinkingContent,
  type TextContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { buildPayload } from "./protocol.ts";

const ENDPOINT = "https://api.commandcode.ai/alpha/generate";
export const COMMAND_CODE_COMPATIBILITY_VERSION = "1.22.0";
const MAX_CONTINUATIONS = 5;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const COMMAND_CODE_STREAM_LIMITS = Object.freeze({
  lineBytes: 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  events: 100_000,
});
const MAX_LINE_BYTES = COMMAND_CODE_STREAM_LIMITS.lineBytes;
const MAX_STREAM_BYTES = COMMAND_CODE_STREAM_LIMITS.totalBytes;
const MAX_STREAM_EVENTS = COMMAND_CODE_STREAM_LIMITS.events;

type StreamState = {
  partial: AssistantMessage;
  open?: { type: "text" | "thinking"; index: number };
  finished: boolean;
  attemptFinished: boolean;
  rawStopReason?: string;
  finishReason?: unknown;
  bytes: number;
  events: number;
  providerToolIds: Set<string>;
  clientToolCalls: number;
};

export type CommandCodeStreamScheduler = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  yieldToLoop(): Promise<void>;
};

export type CommandCodeStreamOptions = SimpleStreamOptions & {
  /** @internal Deterministic scheduler injection used by stream regression tests. */
  commandCodeScheduler?: CommandCodeStreamScheduler;
};

const DEFAULT_STREAM_SCHEDULER: CommandCodeStreamScheduler = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  yieldToLoop: () => new Promise((resolve) => setImmediate(resolve)),
};
// JavaScript string lengths are UTF-16 code units. Using that cheap measure avoids
// re-encoding every token while still bounding cooperative render batches.
const DELTA_BURST_CODE_UNITS = 16 * 1024;
const PARSER_SLICE_LINES = 256;
const PARSER_SLICE_MS = 8;

type PendingDelta = {
  type: "text" | "thinking";
  contentIndex: number;
  delta: string;
};

class DeltaCoalescer {
  private pending?: PendingDelta;
  private timer?: unknown;
  private disposed = false;
  private generatedCodeUnits = 0;
  private readonly stream: AssistantMessageEventStream;
  private readonly state: StreamState;
  private readonly scheduler: CommandCodeStreamScheduler;

  constructor(stream: AssistantMessageEventStream, state: StreamState, scheduler: CommandCodeStreamScheduler) {
    this.stream = stream;
    this.state = state;
    this.scheduler = scheduler;
  }

  append(type: "text" | "thinking", contentIndex: number, delta: string): boolean {
    if (!delta || this.disposed) return false;
    const current = this.pending;
    if (current && (current.type !== type || current.contentIndex !== contentIndex)) this.flush();
    this.generatedCodeUnits += delta.length;
    if (this.pending) this.pending.delta += delta;
    else {
      this.pending = { type, contentIndex, delta };
      this.timer = this.scheduler.setTimer(() => {
        if (!this.disposed) this.flush();
      }, this.flushDelay());
    }
    if (this.pending.delta.length < DELTA_BURST_CODE_UNITS) return false;
    this.flush();
    return true;
  }

  flush(): void {
    if (this.timer !== undefined) {
      this.scheduler.clearTimer(this.timer);
      this.timer = undefined;
    }
    const pending = this.pending;
    this.pending = undefined;
    if (!pending || this.disposed || !pending.delta) return;
    this.stream.push(pending.type === "text"
      ? { type: "text_delta", contentIndex: pending.contentIndex, delta: pending.delta, partial: this.state.partial }
      : { type: "thinking_delta", contentIndex: pending.contentIndex, delta: pending.delta, partial: this.state.partial });
  }

  dispose(): void {
    if (this.timer !== undefined) this.scheduler.clearTimer(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.disposed = true;
  }

  private flushDelay(): number {
    if (this.generatedCodeUnits < 32 * 1024) return 50;
    if (this.generatedCodeUnits < 128 * 1024) return 100;
    if (this.generatedCodeUnits < 512 * 1024) return 250;
    return 500;
  }
}

class SafeCommandCodeError extends Error {}
class RetryableCommandCodeError extends SafeCommandCodeError {}

const TERMINAL_ACCOUNT_ERROR = /(?:insufficient[_ -]?quota|quota exceeded|out of (?:budget|credits?)|billing|payment required|subscription limit|usage limit|plan limit|available balance|freeusagelimiterror|gousagelimiterror)/i;

function structuredErrorText(value: unknown, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  if (Array.isArray(value)) return value.map((item) => structuredErrorText(item, depth + 1)).join(" ");
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => /^(?:code|type|message|reason|error|detail|status)$/i.test(key))
    .map(([, item]) => structuredErrorText(item, depth + 1))
    .join(" ");
}

export function isTerminalAccountError(value: unknown): boolean {
  return TERMINAL_ACCOUNT_ERROR.test(structuredErrorText(value));
}

function emptyMessage(model: Model<string>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function normalizeStop(reason: unknown): StopReason {
  const value = String(reason ?? "").toLowerCase().replaceAll("-", "_");
  if (["tool_call", "tool_calls", "tool_use"].includes(value)) return "toolUse";
  if (["length", "max_token", "max_tokens"].includes(value)) return "length";
  return "stop";
}

function displayedError(error: unknown, callerAborted: boolean, timedOut: boolean): string {
  if (callerAborted) return "Request aborted";
  if (timedOut) return "Command Code request timed out";
  if (error instanceof SafeCommandCodeError) return error.message;
  return "Command Code request failed";
}

function closeOpen(stream: AssistantMessageEventStream, state: StreamState, deltas: DeltaCoalescer): void {
  deltas.flush();
  if (!state.open) return;
  const { type, index } = state.open;
  const part = state.partial.content[index];
  if (type === "text" && part?.type === "text") {
    stream.push({ type: "text_end", contentIndex: index, content: part.text, partial: state.partial });
  } else if (type === "thinking" && part?.type === "thinking") {
    stream.push({ type: "thinking_end", contentIndex: index, content: part.thinking, partial: state.partial });
  }
  state.open = undefined;
}

function startBlock(
  stream: AssistantMessageEventStream,
  state: StreamState,
  deltas: DeltaCoalescer,
  type: "text" | "thinking",
  forceNew = false,
): number {
  if (!forceNew && state.open?.type === type) return state.open.index;
  closeOpen(stream, state, deltas);
  const index = state.partial.content.length;
  if (type === "text") state.partial.content.push({ type: "text", text: "" });
  else state.partial.content.push({ type: "thinking", thinking: "" });
  state.open = { type, index };
  stream.push(type === "text"
    ? { type: "text_start", contentIndex: index, partial: state.partial }
    : { type: "thinking_start", contentIndex: index, partial: state.partial });
  return index;
}

function soleRequiredToolField(context: Context, toolName: string): string | undefined {
  const tool = context.tools?.find((candidate) => candidate.name === toolName);
  const schema = tool?.parameters as Record<string, unknown> | undefined;
  const required = schema?.required;
  const properties = schema?.properties;
  if (!Array.isArray(required) || required.length !== 1 || typeof required[0] !== "string") return undefined;
  if (typeof properties !== "object" || properties === null || !(required[0] in properties)) return undefined;
  return required[0];
}

function asObject(value: unknown, soleField?: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = value;
    }
  }
  if (Array.isArray(parsed) && parsed.length === 1) parsed = parsed[0];
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return soleField ? { [soleField]: parsed } : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function handleEvent(
  stream: AssistantMessageEventStream,
  state: StreamState,
  deltas: DeltaCoalescer,
  model: Model<string>,
  context: Context,
  event: Record<string, unknown>,
): boolean {
  let burstFlushed = false;
  switch (event.type) {
    case "text-delta": {
      const delta = typeof event.text === "string" ? event.text : "";
      if (!delta) break;
      const index = startBlock(stream, state, deltas, "text");
      (state.partial.content[index] as TextContent).text += delta;
      burstFlushed = deltas.append("text", index, delta);
      break;
    }
    case "reasoning-start":
      startBlock(stream, state, deltas, "thinking", true);
      break;
    case "reasoning-delta": {
      const delta = typeof event.text === "string" ? event.text : "";
      if (!delta) break;
      const index = startBlock(stream, state, deltas, "thinking");
      (state.partial.content[index] as ThinkingContent).thinking += delta;
      burstFlushed = deltas.append("thinking", index, delta);
      break;
    }
    case "reasoning-end":
      if (state.open?.type === "thinking") closeOpen(stream, state, deltas);
      break;
    case "tool-call": {
      deltas.flush();
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (event.providerExecuted === true) {
        if (!id) throw new SafeCommandCodeError("Command Code provider tool execution was incomplete");
        state.providerToolIds.add(id);
        break;
      }
      closeOpen(stream, state, deltas);
      const index = state.partial.content.length;
      const name = typeof event.toolName === "string" ? event.toolName : "";
      const rawInput = Object.hasOwn(event, "input") ? event.input : event.args;
      const call: ToolCall = {
        type: "toolCall",
        id,
        name,
        arguments: asObject(rawInput, soleRequiredToolField(context, name)),
      };
      state.partial.content.push(call);
      state.clientToolCalls += 1;
      stream.push({ type: "toolcall_start", contentIndex: index, partial: state.partial });
      stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: state.partial });
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: state.partial });
      break;
    }
    case "tool-result": {
      deltas.flush();
      // Server tool results have no Pi content-block equivalent. They remain
      // provider-side and must never cause the paired call to execute in Pi.
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      if (id) state.providerToolIds.delete(id);
      break;
    }
    case "finish": {
      closeOpen(stream, state, deltas);
      const usage = typeof event.totalUsage === "object" && event.totalUsage !== null
        ? event.totalUsage as Record<string, unknown>
        : {};
      const details = typeof usage.inputTokenDetails === "object" && usage.inputTokenDetails !== null
        ? usage.inputTokenDetails as Record<string, unknown>
        : {};
      state.partial.usage.input += number(usage.inputTokens);
      state.partial.usage.output += number(usage.outputTokens);
      state.partial.usage.cacheRead += number(details.cacheReadTokens);
      state.partial.usage.cacheWrite += number(details.cacheWriteTokens);
      state.partial.usage.totalTokens = state.partial.usage.input + state.partial.usage.output + state.partial.usage.cacheRead + state.partial.usage.cacheWrite;
      state.partial.usage.cost = calculateCost(model, state.partial.usage);
      const systemPromptTokens = number(event.systemPromptTokens);
      if (systemPromptTokens > 0) {
        state.partial.diagnostics = [
          ...(state.partial.diagnostics ?? []),
          { type: "command-code.system-prompt-tokens", timestamp: Date.now(), details: { tokens: systemPromptTokens } },
        ];
      }
      if (state.providerToolIds.size > 0) {
        throw new SafeCommandCodeError("Command Code provider tool execution was incomplete");
      }
      state.finishReason = event.finishReason;
      state.rawStopReason = typeof event.rawFinishReason === "string" ? event.rawFinishReason : undefined;
      state.attemptFinished = true;
      break;
    }
    case "abort":
      closeOpen(stream, state, deltas);
      state.partial.stopReason = "aborted";
      state.partial.errorMessage = "Request aborted";
      state.attemptFinished = true;
      state.finished = true;
      stream.push({ type: "error", reason: "aborted", error: state.partial });
      break;
    case "error": {
      deltas.flush();
      const detail = typeof event.error === "object" && event.error !== null ? event.error as Record<string, unknown> : undefined;
      const status = number(detail?.statusCode ?? event.statusCode);
      if (isTerminalAccountError(detail ?? event)) {
        throw new SafeCommandCodeError("Command Code quota exceeded");
      }
      if (status === 429 || status >= 500) {
        throw new RetryableCommandCodeError(`Command Code stream error (${status})`);
      }
      throw new SafeCommandCodeError(status ? `Command Code stream error (${status})` : "Command Code stream error");
    }
  }
  return burstFlushed;
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Start cancellation without allowing an uncooperative source to block terminal delivery. */
function cancelAndReleaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // A synchronous cancellation failure is intentionally opaque.
  } finally {
    // releaseLock() is synchronous and does not wait for the underlying source's
    // cancel promise. Pending reads are rejected by the stream implementation.
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  try { void body.cancel().catch(() => undefined); } catch { /* opaque cleanup failure */ }
}

async function consumeNdjson(
  body: ReadableStream<Uint8Array>,
  stream: AssistantMessageEventStream,
  state: StreamState,
  deltas: DeltaCoalescer,
  model: Model<string>,
  context: Context,
  signal: AbortSignal,
  scheduler: CommandCodeStreamScheduler,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;
  try {
    while (!state.attemptFinished && !state.finished) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await readWithSignal(reader, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new RetryableCommandCodeError("Command Code network error");
      }
      const { done, value } = result;
      if (value) {
        state.bytes += value.byteLength;
        if (state.bytes > MAX_STREAM_BYTES) throw new SafeCommandCodeError("Command Code stream exceeded the size limit");
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) {
        reachedEof = true;
        buffer += decoder.decode();
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES && !buffer.includes("\n")) {
        throw new SafeCommandCodeError("Command Code stream event exceeded the size limit");
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (done && buffer.trim()) {
        lines.push(buffer);
        buffer = "";
      }
      let sliceLines = 0;
      let sliceStarted = scheduler.now();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new SafeCommandCodeError("Command Code stream event exceeded the size limit");
        state.events += 1;
        if (state.events > MAX_STREAM_EVENTS) throw new SafeCommandCodeError("Command Code stream exceeded the event limit");
        let burstFlushed = false;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            burstFlushed = handleEvent(stream, state, deltas, model, context, parsed as Record<string, unknown>);
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (state.attemptFinished || state.finished) break;
        sliceLines += 1;
        if (burstFlushed || sliceLines >= PARSER_SLICE_LINES || scheduler.now() - sliceStarted >= PARSER_SLICE_MS) {
          signal.throwIfAborted();
          await scheduler.yieldToLoop();
          signal.throwIfAborted();
          sliceLines = 0;
          sliceStarted = scheduler.now();
        }
      }
      if (done) break;
    }
  } finally {
    deltas.flush();
    if (!reachedEof) cancelAndReleaseReader(reader);
    else reader.releaseLock();
  }
}

async function classifyHttpError(response: Response, signal: AbortSignal): Promise<SafeCommandCodeError> {
  const status = response.status;
  let parsed: unknown;
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
      while (bytes <= 64 * 1024) {
        const { done, value } = await readWithSignal(reader, signal);
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          if (bytes > 64 * 1024) break;
          text += decoder.decode(value, { stream: true });
        }
      }
      if (bytes <= 64 * 1024) {
        text += decoder.decode();
        try { parsed = JSON.parse(text) as unknown; } catch { /* unstructured bodies stay opaque */ }
      }
    } finally {
      cancelAndReleaseReader(reader);
    }
  }
  if (isTerminalAccountError(parsed)) return new SafeCommandCodeError("Command Code quota exceeded");
  if (status === 429 || status >= 500) return new RetryableCommandCodeError(`Command Code request failed (${status})`);
  return new SafeCommandCodeError(`Command Code request failed (${status})`);
}

type CommandCodeHeaderFlags = {
  cmdZdr: boolean;
  deepseekInternal: boolean;
};

function commandCodeHeaderFlags(environment: NodeJS.ProcessEnv = process.env): CommandCodeHeaderFlags {
  return {
    cmdZdr: environment.CMD_ZDR === "1",
    deepseekInternal: environment.CMD_PROVIDER_DEEPSEEK_INTERNAL === "1",
  };
}

export function mergeHeaders(
  apiKey: string,
  custom: ProviderHeaders = {},
  flags: CommandCodeHeaderFlags = commandCodeHeaderFlags(),
): Record<string, string> {
  const headers = new Map<string, [string, string]>([
    ["content-type", ["Content-Type", "application/json"]],
    ["authorization", ["Authorization", `Bearer ${apiKey}`]],
    ["user-agent", ["User-Agent", "cli"]],
    ["x-cli-environment", ["x-cli-environment", "production"]],
    ["x-command-code-version", ["x-command-code-version", COMMAND_CODE_COMPATIBILITY_VERSION]],
  ]);
  if (flags.cmdZdr) headers.set("x-cmd-zdr", ["x-cmd-zdr", "1"]);
  if (flags.deepseekInternal) {
    headers.set("x-cmd-provider-deepseek-internal", ["x-cmd-provider-deepseek-internal", "1"]);
  }
  for (const [name, value] of Object.entries(custom)) {
    const key = name.toLowerCase();
    if (value === null) headers.delete(key);
    else headers.set(key, [name, value]);
  }
  return Object.fromEntries([...headers.values()]);
}

export function streamCommandCode(
  model: Model<string>,
  context: Context,
  options: CommandCodeStreamOptions = {},
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const state: StreamState = {
    partial: emptyMessage(model),
    finished: false,
    attemptFinished: false,
    bytes: 0,
    events: 0,
    providerToolIds: new Set(),
    clientToolCalls: 0,
  };
  const scheduler = options.commandCodeScheduler ?? DEFAULT_STREAM_SCHEDULER;
  const deltas = new DeltaCoalescer(stream, state, scheduler);

  void (async () => {
    stream.push({ type: "start", partial: state.partial });
    const timeoutSignal = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try {
      signal.throwIfAborted();
      if (!options.apiKey) throw new SafeCommandCodeError("Command Code credentials are unavailable. Run `cmd login`.");
      let payload: unknown = buildPayload(model, context, options);
      const replacement = await options.onPayload?.(payload, model);
      if (replacement !== undefined) payload = replacement;

      for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt += 1) {
        state.attemptFinished = false;
        state.rawStopReason = undefined;
        state.finishReason = undefined;
        let response: Response;
        try {
          response = await (options.fetch ?? globalThis.fetch)(ENDPOINT, {
            method: "POST",
            headers: mergeHeaders(options.apiKey, options.headers),
            body: JSON.stringify(payload),
            signal,
            redirect: "error",
          });
        } catch (error) {
          if (signal.aborted) throw error;
          // Pi recognizes “network error” as retryable. Never include the raw
          // fetch error, request URL, headers, or response text.
          throw new RetryableCommandCodeError("Command Code network error");
        }
        const providerResponse: ProviderResponse = { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
        try {
          await options.onResponse?.(providerResponse, model);
        } catch (error) {
          cancelBody(response.body);
          throw error;
        }
        if (!response.ok) throw await classifyHttpError(response, signal);
        if (!response.body) throw new RetryableCommandCodeError("Command Code stream ended before a terminal response event");
        await consumeNdjson(response.body, stream, state, deltas, model, context, signal, scheduler);
        if (state.finished) break;
        if (!state.attemptFinished) throw new RetryableCommandCodeError("Command Code stream ended before a terminal response event");
        if (state.rawStopReason === "pause_turn" && attempt < MAX_CONTINUATIONS) {
          deltas.flush();
          signal.throwIfAborted();
          continue;
        }
        const normalized = normalizeStop(state.finishReason);
        state.partial.stopReason = normalized === "toolUse" && state.clientToolCalls === 0 ? "stop" : normalized;
        state.partial.rawStopReason = state.rawStopReason;
        state.finished = true;
        stream.push({
          type: "done",
          reason: state.partial.stopReason as "stop" | "length" | "toolUse",
          message: state.partial,
        });
        break;
      }
    } catch (error) {
      if (!state.finished) {
        closeOpen(stream, state, deltas);
        const callerAborted = options.signal?.aborted === true;
        state.partial.stopReason = callerAborted ? "aborted" : "error";
        state.partial.errorMessage = displayedError(error, callerAborted, timeoutSignal.aborted);
        stream.push(callerAborted
          ? { type: "error", reason: "aborted", error: state.partial }
          : { type: "error", reason: "error", error: state.partial });
      }
    } finally {
      deltas.flush();
      deltas.dispose();
      stream.end(state.partial);
    }
  })();

  return stream;
}
