import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import {
  createHerdrAdapter,
  type ForkPlacement,
  type HerdrAdapter,
} from "./herdr.ts";
import {
  captureForkSnapshot,
  cleanupHandoff,
  createForkFromSnapshot,
  createHandoff,
  getForkCandidates,
  type ForkCandidate,
} from "./session.ts";

const RIGHT_CHOICE = "Right";
const BELOW_CHOICE = "Below";
const TAB_CHOICE = "New tab";

export function parsePlacement(args: string): ForkPlacement | undefined | "invalid" {
  const value = args.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "horizontal" || value === "vertical" || value === "tab") return value;
  return "invalid";
}

class MessageList {
  private selectedIndex: number;
  private readonly candidates: ForkCandidate[];
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly done: (value: ForkCandidate | null) => void;

  constructor(
    candidates: ForkCandidate[],
    theme: Theme,
    keybindings: KeybindingsManager,
    done: (value: ForkCandidate | null) => void,
  ) {
    this.candidates = candidates;
    this.theme = theme;
    this.keybindings = keybindings;
    this.done = done;
    this.selectedIndex = Math.max(0, candidates.length - 1);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex = this.selectedIndex === 0 ? this.candidates.length - 1 : this.selectedIndex - 1;
    } else if (this.keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex = this.selectedIndex === this.candidates.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done(this.candidates[this.selectedIndex] ?? null);
    } else if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(null);
    }
  }

  render(width: number): string[] {
    const maxVisible = 10;
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.candidates.length - maxVisible));
    const end = Math.min(start + maxVisible, this.candidates.length);
    const lines: string[] = [];
    for (let index = start; index < end; index += 1) {
      const candidate = this.candidates[index];
      const selected = index === this.selectedIndex;
      const text = candidate.text.replace(/\n/g, " ").trim();
      const content = truncateToWidth(text, Math.max(1, width - 2));
      const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
      lines.push(prefix + (selected ? this.theme.bold(content) : content));
      lines.push(this.theme.fg("muted", truncateToWidth(`  Message ${index + 1} of ${this.candidates.length}`, width)));
      lines.push("");
    }
    if (start > 0 || end < this.candidates.length) {
      lines.push(this.theme.fg("muted", `  (${this.selectedIndex + 1}/${this.candidates.length})`));
    }
    return lines;
  }

  invalidate(): void {}
}

export async function chooseForkCandidate(
  ctx: ExtensionCommandContext,
  candidates: ForkCandidate[],
): Promise<ForkCandidate | null> {
  return ctx.ui.custom<ForkCandidate | null>((tui, theme, keybindings, done) => {
    const container = new Container();
    const list = new MessageList(candidates, theme, keybindings, done);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.bold("Fork to Pane"), 1, 0));
    container.addChild(new Text(theme.fg("muted", "Select a user message; its prompt opens in the new pane editor."), 1, 0));
    container.addChild(new Spacer(1));
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    container.addChild(new Spacer(1));
    container.addChild(list);
    container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export interface ForkToPaneDependencies {
  herdr: HerdrAdapter;
  bootstrapPath: string;
  chooseCandidate: typeof chooseForkCandidate;
  createFork: typeof createForkFromSnapshot;
  createProtectedHandoff: typeof createHandoff;
}

function defaultDependencies(): ForkToPaneDependencies {
  return {
    herdr: createHerdrAdapter(),
    bootstrapPath: fileURLToPath(new URL("./bootstrap.ts", import.meta.url)),
    chooseCandidate: chooseForkCandidate,
    createFork: createForkFromSnapshot,
    createProtectedHandoff: createHandoff,
  };
}

async function choosePlacement(ctx: ExtensionCommandContext): Promise<ForkPlacement | undefined> {
  const choice = await ctx.ui.select("Fork destination", [RIGHT_CHOICE, BELOW_CHOICE, TAB_CHOICE]);
  if (choice === RIGHT_CHOICE) return "horizontal";
  if (choice === BELOW_CHOICE) return "vertical";
  if (choice === TAB_CHOICE) return "tab";
  return undefined;
}

export async function runForkToPane(
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: ForkToPaneDependencies,
): Promise<void> {
  const parsed = parsePlacement(args);
  if (parsed === "invalid") {
    ctx.ui.notify("Usage: /fork-to-pane [horizontal|vertical|tab]", "error");
    return;
  }
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("fork-to-pane requires interactive TUI mode", "error");
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.ui.notify("Wait for Pi to become idle before forking", "warning");
    return;
  }
  const sourceFile = ctx.sessionManager.getSessionFile();
  if (!sourceFile || !existsSync(sourceFile)) {
    ctx.ui.notify("The current session has not been saved yet", "error");
    return;
  }
  const host = dependencies.herdr.validateSource();
  if (!host.ok) {
    ctx.ui.notify(host.error || "Herdr is unavailable", "error");
    return;
  }

  const placement = parsed ?? await choosePlacement(ctx);
  if (!placement) return;

  const candidates = getForkCandidates(ctx.sessionManager.getEntries());
  if (candidates.length === 0) {
    ctx.ui.notify("No user messages to fork from", "warning");
    return;
  }
  const selected = await dependencies.chooseCandidate(ctx, candidates);
  if (!selected) return;

  let handoffPath: string | undefined;
  try {
    const snapshot = captureForkSnapshot(ctx.sessionManager, selected, {
      model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
      thinkingLevel: ctx.thinkingLevel,
    });
    const fork = dependencies.createFork(snapshot);
    const handoff = dependencies.createProtectedHandoff(fork);
    handoffPath = handoff.path;
    const launched = await dependencies.herdr.launch({
      placement,
      cwd: ctx.cwd,
      sessionPath: fork.path,
      sessionId: fork.sessionId,
      bootstrapPath: dependencies.bootstrapPath,
      handoffPath: handoff.path,
      handoffNonce: handoff.nonce,
      runtimeState: fork.launchState,
    });
    if (!launched.ok) {
      cleanupHandoff(handoff.path);
      const cleanup = launched.cleanupError ? `; ${launched.cleanupError}` : "";
      throw new Error(`${launched.error || "Herdr launch failed"}${cleanup}`);
    }
    cleanupHandoff(handoff.path);
    handoffPath = undefined;
    const destination = placement === "horizontal" ? "to the right" : placement === "vertical" ? "below" : "in a new tab";
    ctx.ui.notify(`Fork opened ${destination}; source session unchanged`, "info");
  } catch (error) {
    if (handoffPath) cleanupHandoff(handoffPath);
    ctx.ui.notify(`Fork to pane failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export function createForkToPaneExtension(
  pi: ExtensionAPI,
  overrides: Partial<ForkToPaneDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies(), ...overrides };
  pi.registerCommand("fork-to-pane", {
    description: "Fork into a new Herdr pane",
    getArgumentCompletions: (prefix: string) => ["horizontal", "vertical", "tab"]
      .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
      .map((value) => ({ value, label: value })),
    handler: (args, ctx) => runForkToPane(args, ctx, dependencies),
  });
}

export default function forkToPaneExtension(pi: ExtensionAPI): void {
  createForkToPaneExtension(pi);
}
