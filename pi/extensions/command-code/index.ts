import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { Key, matchesKey, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import { COMMAND_CODE_AUTH_PATH, CommandCodeAuthError, readCommandCodeApiKey } from "./src/auth.ts";
import {
  COMMAND_CODE_API,
  COMMAND_CODE_BASE_URL,
  COMMAND_CODE_MODELS,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./src/catalogue.ts";
import { streamCommandCode } from "./src/stream.ts";
import {
  CommandCodeUsageError,
  type CommandCodeUsageView,
  fetchCommandCodeUsage,
  renderCommandCodeUsage,
} from "./src/usage.ts";

export const commandCodeProvider: Provider<typeof COMMAND_CODE_API> = createProvider({
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  baseUrl: COMMAND_CODE_BASE_URL,
  auth: {
    apiKey: {
      name: "Command Code credentials",
      async check({ signal }) {
        signal.throwIfAborted();
        try {
          await readCommandCodeApiKey();
          signal.throwIfAborted();
          return { type: "api_key", source: COMMAND_CODE_AUTH_PATH };
        } catch (error) {
          if (error instanceof CommandCodeAuthError) return undefined;
          throw error;
        }
      },
      async resolve({ signal }) {
        signal.throwIfAborted();
        const apiKey = await readCommandCodeApiKey();
        signal.throwIfAborted();
        return { auth: { apiKey }, source: COMMAND_CODE_AUTH_PATH };
      },
    },
  },
  models: COMMAND_CODE_MODELS,
  api: { stream: streamCommandCode, streamSimple: streamCommandCode },
});

type UsageDependencies = {
  readApiKey(): Promise<string>;
  fetchUsage(options: { apiKey: string; signal?: AbortSignal }): Promise<CommandCodeUsageView>;
};

type UsageModalState =
  | { kind: "loading" }
  | { kind: "ready"; usage: CommandCodeUsageView }
  | { kind: "error"; message: string };

const SAFE_USAGE_MESSAGES = new Set([
  "Command Code session expired. Run `cmd login`.",
  "Command Code usage is temporarily unavailable (429).",
  "Command Code usage is temporarily unavailable.",
  "Command Code returned invalid usage data.",
  "Command Code usage response exceeded the size limit.",
  "Command Code usage request timed out.",
  "Command Code usage request cancelled.",
  "Unable to reach Command Code.",
]);

function safeUsageError(error: unknown): string {
  if (error instanceof CommandCodeAuthError) return "Command Code credentials are unavailable. Run `cmd login`.";
  if (error instanceof CommandCodeUsageError
    && (SAFE_USAGE_MESSAGES.has(error.message) || /^Command Code usage request failed \(\d{3}\)\.$/.test(error.message))) {
    return error.message;
  }
  return "Unable to load Command Code usage.";
}

function styledWrapped(theme: Theme, color: "accent" | "muted" | "dim" | "text" | "error", text: string, width: number, bold = false): string[] {
  const styled = theme.fg(color, bold ? theme.bold(text) : text);
  return wrapTextWithAnsi(styled, Math.max(1, width));
}

export class UsageModal implements Component {
  private state: UsageModalState = { kind: "loading" };
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly loadUsage: (signal: AbortSignal) => Promise<CommandCodeUsageView>;
  private readonly now: number;
  private controller: AbortController | undefined;
  private generation = 0;
  private disposed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    done: () => void,
    loadUsage: (signal: AbortSignal) => Promise<CommandCodeUsageView>,
    now = Date.now(),
  ) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.loadUsage = loadUsage;
    this.now = now;
    void this.reload();
  }

  private async reload(): Promise<void> {
    if (this.disposed) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    this.state = { kind: "loading" };
    this.tui.requestRender();
    try {
      const usage = await this.loadUsage(controller.signal);
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return;
      this.state = { kind: "ready", usage };
    } catch (error) {
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return;
      this.state = { kind: "error", message: safeUsageError(error) };
    } finally {
      if (!this.disposed && generation === this.generation) this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    if (this.state.kind === "loading") {
      return [
        ...styledWrapped(this.theme, "accent", "COMMAND CODE USAGE", safeWidth, true),
        "",
        ...styledWrapped(this.theme, "dim", "Loading usage…", safeWidth),
        "",
        ...styledWrapped(this.theme, "dim", "Press Enter or Escape to close", safeWidth),
      ];
    }
    if (this.state.kind === "error") {
      return [
        ...styledWrapped(this.theme, "accent", "COMMAND CODE USAGE", safeWidth, true),
        "",
        ...styledWrapped(this.theme, "error", this.state.message, safeWidth),
        "",
        ...styledWrapped(this.theme, "dim", "Press r to retry · Enter or Escape to close", safeWidth),
      ];
    }

    let continuation: "title" | "muted" | "dim" | null = "title";
    return renderCommandCodeUsage(this.state.usage, safeWidth, this.now).map((line) => {
      if (line === "") {
        continuation = null;
        return line;
      }
      if (line === "Usage limits") return this.theme.bold(line);
      if (line.startsWith("Cycle:") || line.startsWith("Full breakdown")) continuation = "muted";
      else if (line.startsWith("Press Enter")) continuation = "dim";
      const styled = continuation === "title"
        ? this.theme.fg("accent", this.theme.bold(line))
        : continuation === "muted"
          ? this.theme.fg("muted", line)
          : continuation === "dim"
            ? this.theme.fg("dim", line)
            : this.theme.fg("text", line);
      return visibleWidth(styled) <= safeWidth ? styled : wrapTextWithAnsi(styled, safeWidth)[0] ?? "";
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.close();
      return;
    }
    if (this.state.kind === "error" && matchesKey(data, "r")) void this.reload();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.controller?.abort();
  }

  private close(): void {
    if (this.disposed) return;
    this.dispose();
    this.done();
  }
}

export function createCommandCodeUsageHandler(
  dependencies: UsageDependencies = {
    readApiKey: readCommandCodeApiKey,
    fetchUsage: fetchCommandCodeUsage,
  },
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  const load = async (signal: AbortSignal): Promise<CommandCodeUsageView> => {
    signal.throwIfAborted();
    const apiKey = await dependencies.readApiKey();
    signal.throwIfAborted();
    return await dependencies.fetchUsage({ apiKey, signal });
  };

  return async (_args, ctx) => {
    if (ctx.mode === "tui") {
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
        new UsageModal(tui, theme, () => done(undefined), load));
      return;
    }

    try {
      const usage = await load(new AbortController().signal);
      if (ctx.hasUI) ctx.ui.notify(`Command Code ${usage.plan} Plan · ${Math.round(usage.percentage)}% used`, "info");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(safeUsageError(error), "error");
    }
  };
}

export default function commandCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(commandCodeProvider);
  pi.registerCommand("command-code-usage", {
    description: "Show Command Code plan and usage limits",
    handler: createCommandCodeUsageHandler(),
  });
}
