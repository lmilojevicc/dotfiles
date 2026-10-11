import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ConfigState } from "./config.ts";
import type { FileResult, FileSession, FileSessionOptions, Redactor } from "./contracts.ts";
import { loadConfig, offConfig, safeStatus } from "./config.ts";
import { createNativeRedactor } from "./native.ts";
import { reserveBranchAliases, reserveGeneratedAliases } from "./alias-history.ts";
import { CENSORED, censoredMessages, censoredToolResult, sanitizeJson, sanitizeMessages, sanitizeToolResult } from "./sanitize.ts";

type Host = typeof import("@earendil-works/pi-coding-agent");
export interface Dependencies {
  loadConfig?: () => Promise<ConfigState>;
  createRedactor?: typeof createNativeRedactor;
  createFileSession?: (options: FileSessionOptions) => FileSession;
  loadTools?: () => Promise<Pick<Host, "createReadToolDefinition" | "createEditToolDefinition" | "createWriteToolDefinition">>;
}
export async function installRedaction(pi: ExtensionAPI, deps: Dependencies = {}): Promise<void> {
  const state = await (deps.loadConfig ?? loadConfig)();
  const config = state.state === "invalid" ? offConfig() : state.config;
  const sources = state.state === "invalid" ? { toolResults: true, userMessages: true, systemPrompt: true } : config.sources;
  let failed = state.state === "invalid";
  let redactor: Redactor | undefined;
  const files = new Map<string, FileSession>();
  // Provenance only: WeakSet never retains results or exempts their strings from scanning.
  const ownedDisplayDetails = new WeakSet<object>();
  const scan: Redactor["redact"] = value => {
    if (failed) throw new Error("Redaction unavailable");
    try {
      redactor ??= (deps.createRedactor ?? createNativeRedactor)(config);
      return redactor.redact(value);
    } catch { failed = true; throw new Error("Redaction unavailable"); }
  };
  const text = (value: string): string => {
    if (failed) throw new Error("Redaction unavailable");
    try {
      redactor ??= (deps.createRedactor ?? createNativeRedactor)(config);
      return redactor.redactText ? redactor.redactText(value) : redactor.redact(value).text;
    } catch { failed = true; throw new Error("Redaction unavailable"); }
  };
  const hasAutomaticDetectors = Object.values(config.detectors).some(Boolean);
  let reservedFor: ExtensionContext["sessionManager"] | undefined;
  const reserveHistory = (ctx: Pick<ExtensionContext, "sessionManager">): void => {
    if (failed) throw new Error("Redaction unavailable");
    if (!hasAutomaticDetectors) return;
    try {
      const manager = ctx.sessionManager;
      if (!manager) throw new Error();
      if (reservedFor === manager) return;
      reserveBranchAliases(manager.getBranch(), config.detectors, scan);
      reservedFor = manager;
    } catch { failed = true; throw new Error("Redaction unavailable"); }
  };
  pi.registerCommand("redaction-status", {
    description: "Show redaction flags and counts (no private values)",
    handler: async (_args, ctx) => { ctx.ui.notify(safeStatus(state, failed), failed ? "warning" : "info"); },
  });
  pi.registerCommand("redaction", {
    description: "Configure private redaction locally (draft until Save & reload)",
    handler: async (args, ctx) => {
      const { openSettings } = await import("./settings-command.ts");
      await openSettings(pi, args, ctx, {
        summary: state.state === "invalid" || failed ? "unavailable (protected transmission censored)" : state.state,
        config: state.state === "invalid" ? undefined : config,
      });
    },
  });
  if (state.state === "inactive") return;

  pi.on("input", (event, ctx) => {
    try {
      reserveHistory(ctx);
      // Even exempt user text may introduce token IDs. Reserve tokens only, never redact that raw text.
      if (!sources.userMessages) {
        reserveGeneratedAliases(event.text, config.detectors, scan);
        return { action: "continue" };
      }
      return { action: "transform", text: text(event.text), images: [] };
    } catch {
      failed = true;
      return sources.userMessages ? { action: "transform", text: CENSORED, images: [] } : { action: "continue" };
    }
  });
  pi.on("tool_result", (event, ctx) => {
    if (!sources.toolResults) return;
    try {
      reserveHistory(ctx);
      if (typeof event.details === "object" && event.details !== null && ownedDisplayDetails.has(event.details)) {
        // Mandatory output remains strict. Only this adapter's optional presentation is isolated.
        const result = sanitizeToolResult({ ...event, details: undefined }, text);
        try { result.details = sanitizeJson(event.details, text); }
        catch {
          // Scanner/protection failures latch in text(); never disguise them as display failures.
          if (failed) throw new Error("Redaction unavailable");
          result.details = null;
        }
        return result;
      }
      return sanitizeToolResult(event, text);
    } catch { failed = true; return censoredToolResult(event); }
  });
  pi.on("cache_warming_decision", () => ({ action: "stop" }));
  pi.on("session_before_compact", (_event, ctx) => {
    try { ctx.ui.notify("Redaction: compaction blocked (Pi summaries bypass filtering). Start a fresh session instead.", "warning"); } catch {}
    return { cancel: true };
  });
  pi.on("session_before_tree", (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    try { ctx.ui.notify("Redaction: branch summarization blocked. Navigate without a summary instead.", "warning"); } catch {}
    return { cancel: true };
  });
  pi.on("before_agent_start", (event, ctx) => {
    // Pi projects forceSystemPrompt after context hooks, so sanitize that override at its source.
    if (!sources.systemPrompt || event.systemPromptOptions.forceSystemPrompt === undefined) return;
    try { reserveHistory(ctx); return { systemPrompt: text(event.systemPrompt) }; }
    catch { failed = true; return { systemPrompt: CENSORED }; }
  });
  pi.on("context_with_system", (event, ctx) => {
    try {
      if (failed) return { messages: censoredMessages(event.messages, !sources.userMessages) };
      reserveHistory(ctx);
      return { messages: sanitizeMessages(event.messages, sources, text) };
    } catch { failed = true; return { messages: censoredMessages(event.messages, !sources.userMessages) }; }
  });
  // A replacement payload, NOT {payload: ...}. Throwing here is swallowed by Pi.
  // On normal requests source-aware context owns filtering; never blanket-walk the wire payload.
  pi.on("before_provider_request", () => failed ? {} : undefined);
  const resetEngine = () => {
    reservedFor = undefined;
    try { redactor?.reset(); }
    catch { failed = true; throw new Error("Redaction unavailable"); }
  };
  const reset = () => {
    reservedFor = undefined;
    try { for (const session of files.values()) session.reset(); resetEngine(); }
    catch { failed = true; }
    files.clear();
  };
  const resetAndReserve = (ctx: Pick<ExtensionContext, "sessionManager">) => {
    reset();
    try { reserveHistory(ctx); } catch { failed = true; }
  };
  pi.on("session_start", (_event, ctx) => {
    resetAndReserve(ctx);
    try { ctx.ui.notify("Text redaction: summaries/cache warming disabled; /bug and transcript sharing are NOT protected.", "warning"); } catch {}
  });
  pi.on("session_tree", (_event, ctx) => { resetAndReserve(ctx); });
  pi.on("session_shutdown", reset);

  if (!sources.toolResults) return;
  let createFiles = deps.createFileSession;
  let Text: typeof import("@earendil-works/pi-tui").Text;
  let read: ReturnType<Host["createReadToolDefinition"]>;
  let edit: ReturnType<Host["createEditToolDefinition"]>;
  let write: ReturnType<Host["createWriteToolDefinition"]>;
  try {
    createFiles ??= (await import("./file-tools.ts")).createFileSession;
    const tools = await (deps.loadTools ?? (() => import("@earendil-works/pi-coding-agent")))();
    read = tools.createReadToolDefinition(process.cwd());
    edit = tools.createEditToolDefinition(process.cwd());
    write = tools.createWriteToolDefinition(process.cwd());
    ({ Text } = await import("@earendil-works/pi-tui"));
  } catch {
    // Initialization failure must not leave raw built-in file operations available to this request.
    failed = true;
    pi.on("tool_call", event => ["read", "edit", "write"].includes(event.toolName) ? { block: true, reason: CENSORED } : undefined);
    return;
  }
  const session = (ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): FileSession => {
    reserveHistory(ctx);
    const cwd = ctx.cwd;
    let fileSession = files.get(cwd);
    if (!fileSession) {
      const guarded: Redactor = { redact(value) { reserveHistory(ctx); return scan(value); }, reset: resetEngine };
      // The file adapter needs the complete configured alias inventory before any read, even {}.
      fileSession = createFiles!({ cwd, redactor: guarded, protectedPaths: [state.path], literalMappings: config.literals });
      files.set(cwd, fileSession);
    }
    return fileSession;
  };
  const safeFailure = () => ({ content: [{ type: "text" as const, text: "[Protected file operation did not return a usable result; re-read before retrying and use complete observed aliases. No private error details exposed.]" }], details: undefined, isError: true });
  function check(signal: AbortSignal | undefined) { if (signal?.aborted) throw new Error("Protected file operation cancelled"); }
  // Display transport cannot turn a committed mutation into an execution failure.
  function displayDetails(result: FileResult) {
    try {
      if (!result.redactionDisplay) return undefined;
      const details = { redactionDisplay: result.redactionDisplay };
      ownedDisplayDetails.add(details);
      return details;
    } catch { return undefined; }
  }
  pi.registerTool<typeof read.parameters, ReturnType<typeof displayDetails>>({ ...read, renderShell: "default", renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("read (redacted text)")), 0, 0), renderResult: undefined, label: "read (redacted text)", description: "Read text files through scoped redaction. Images/binary files are unsupported. Read before editing; partial views cannot authorize unseen edits.",
    async execute(_id, params, signal, _update, ctx) {
      try {
        check(signal);
        const result = await session(ctx).read(params);
        check(signal);
        return { content: [{ type: "text", text: result.text }], structuredContent: result.text, details: displayDetails(result) };
      } catch { return safeFailure(); }
    },
  });
  pi.registerTool<typeof edit.parameters, ReturnType<typeof displayDetails>>({ ...edit, renderShell: "default", renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("edit (redacted text)")), 0, 0), renderResult: undefined, label: "edit (redacted text)", description: "Apply disjoint exact edits against one observed redacted snapshot, all-or-nothing. Preserve only complete aliases from the edited ranges; stale or ambiguous edits are refused.",
    async execute(_id, params, signal, _update, ctx) {
      try {
        check(signal);
        const result = await session(ctx).editMany(params);
        check(signal);
        return { content: [{ type: "text", text: result.text }], details: displayDetails(result) };
      } catch { return safeFailure(); }
    },
  });
  pi.registerTool<typeof write.parameters, ReturnType<typeof displayDetails>>({ ...write, renderShell: "default", renderCall: (_args, theme) => new Text(theme.fg("toolTitle", theme.bold("write (redacted text)")), 0, 0), renderResult: undefined, label: "write (redacted text)", description: "Create text files or rewrite an observed unchanged file. Opaque aliases are allowed only from that file's own snapshot; re-read first. Workspace and private-config paths are guarded.",
    async execute(_id, params, signal, _update, ctx) {
      try {
        check(signal);
        const result = await session(ctx).write(params);
        check(signal);
        return { content: [{ type: "text", text: result.text }], details: displayDetails(result) };
      } catch { return safeFailure(); }
    },
  });
}
export default installRedaction;
