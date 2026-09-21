import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { copyToClipboard, DynamicBorder, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, type KeybindingsManager } from "@earendil-works/pi-tui";
import { createHerdrAdapter } from "./herdr.ts";
import type { ForkPlacement, HostAdapter, HostKind } from "./host.ts";
import { createTmuxAdapter } from "./tmux.ts";
import {
  captureCloneSnapshot,
  captureForkSnapshot,
  captureTreeSnapshot,
  cleanupHandoff,
  createForkFromSnapshot,
  createFullTreeFromSnapshot,
  createHandoff,
  getForkCandidates,
  type ForkCandidate,
  type ForkRuntimeState,
  type FullTreeSnapshot,
} from "./session.ts";

const RIGHT_CHOICE = "Right";
const BELOW_CHOICE = "Below";
const HERDR_TAB_CHOICE = "New tab";
const TMUX_WINDOW_CHOICE = "New window";
const HERDR_MARKERS = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"] as const;

type ToPaneMode = "fork" | "tree" | "clone";

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

export async function chooseTreeEntry(ctx: ExtensionCommandContext): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, _theme, _keybindings, done) => {
    const selector = new TreeSelectorComponent(
      ctx.sessionManager.getTree(),
      ctx.sessionManager.getLeafId(),
      tui.terminal.rows,
      (entryId) => done(entryId),
      () => done(null),
    );
    selector.getTreeList().onLabelEdit = undefined;
    selector.onCopy = async (text) => {
      if (!text) {
        ctx.ui.notify("Selected entry has no text to copy", "error");
        return;
      }
      try {
        await copyToClipboard(text);
        ctx.ui.notify("Copied selected entry", "info");
      } catch (error) {
        ctx.ui.notify(`Could not copy selected entry: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    };
    return selector;
  }, { overlay: true });
}

export interface SessionToPaneDependencies {
  env: NodeJS.ProcessEnv;
  tmux: HostAdapter;
  herdr: HostAdapter;
  bootstrapPath: string;
  chooseCandidate: typeof chooseForkCandidate;
  chooseTreeEntry: typeof chooseTreeEntry;
  createFork: typeof createForkFromSnapshot;
  createFullTree: typeof createFullTreeFromSnapshot;
  createProtectedHandoff: typeof createHandoff;
}

function defaultDependencies(): SessionToPaneDependencies {
  const env = process.env;
  return {
    env,
    tmux: createTmuxAdapter(undefined, env),
    herdr: createHerdrAdapter(undefined, env),
    bootstrapPath: fileURLToPath(new URL("./bootstrap.ts", import.meta.url)),
    chooseCandidate: chooseForkCandidate,
    chooseTreeEntry,
    createFork: createForkFromSnapshot,
    createFullTree: createFullTreeFromSnapshot,
    createProtectedHandoff: createHandoff,
  };
}

export function selectHostAdapter(
  env: NodeJS.ProcessEnv,
  adapters: Pick<SessionToPaneDependencies, "tmux" | "herdr">,
): HostAdapter | undefined {
  if (env.TMUX !== undefined) return adapters.tmux;
  if (HERDR_MARKERS.some((name) => env[name] !== undefined)) return adapters.herdr;
  return undefined;
}

async function choosePlacement(ctx: ExtensionCommandContext, hostKind: HostKind, mode: ToPaneMode): Promise<ForkPlacement | undefined> {
  const finalChoice = hostKind === "tmux" ? TMUX_WINDOW_CHOICE : HERDR_TAB_CHOICE;
  const title = `${mode[0].toUpperCase()}${mode.slice(1)} destination`;
  const choice = await ctx.ui.select(title, [RIGHT_CHOICE, BELOW_CHOICE, finalChoice]);
  if (choice === RIGHT_CHOICE) return "horizontal";
  if (choice === BELOW_CHOICE) return "vertical";
  if (choice === finalChoice) return "tab";
  return undefined;
}

function runtimeState(ctx: ExtensionCommandContext): ForkRuntimeState {
  return {
    model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
    thinkingLevel: ctx.thinkingLevel,
  };
}

function commandName(mode: ToPaneMode): string {
  return `${mode}-to-pane`;
}

function displayMode(mode: ToPaneMode): string {
  return `${mode[0].toUpperCase()}${mode.slice(1)}`;
}

export async function runToPane(
  mode: ToPaneMode,
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: SessionToPaneDependencies,
): Promise<void> {
  const command = commandName(mode);
  const parsed = parsePlacement(args);
  if (parsed === "invalid") {
    ctx.ui.notify(`Usage: /${command} [horizontal|vertical|tab]`, "error");
    return;
  }
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify(`${command} requires interactive TUI mode`, "error");
    return;
  }
  if (!ctx.isIdle() || ctx.hasPendingMessages()) {
    ctx.ui.notify(`Wait for Pi to become idle before ${mode === "clone" ? "cloning" : mode === "tree" ? "copying the tree" : "forking"}`, "warning");
    return;
  }
  const sourceFile = ctx.sessionManager.getSessionFile();
  if (!sourceFile || !existsSync(sourceFile)) {
    ctx.ui.notify("The current session has not been saved yet", "error");
    return;
  }
  const adapter = selectHostAdapter(dependencies.env, dependencies);
  if (!adapter) {
    ctx.ui.notify(`${command} requires tmux or Herdr`, "error");
    return;
  }
  const host = adapter.validateSource();
  if (!host.ok) {
    ctx.ui.notify(host.error || `${adapter.kind} is unavailable`, "error");
    return;
  }

  // Clone captures the editor and runtime leaf before opening any chooser.
  let cloneSnapshot: FullTreeSnapshot | undefined;
  if (mode === "clone") {
    try {
      cloneSnapshot = captureCloneSnapshot(ctx.sessionManager, ctx.ui.getEditorText(), runtimeState(ctx));
    } catch (error) {
      ctx.ui.notify(`Clone to pane failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
  }

  const placement = parsed ?? await choosePlacement(ctx, adapter.kind, mode);
  if (!placement) return;

  let handoffPath: string | undefined;
  try {
    let created;
    if (mode === "fork") {
      const candidates = getForkCandidates(ctx.sessionManager.getEntries());
      if (candidates.length === 0) {
        ctx.ui.notify("No user messages to fork from", "warning");
        return;
      }
      const selected = await dependencies.chooseCandidate(ctx, candidates);
      if (!selected) return;
      created = dependencies.createFork(captureForkSnapshot(ctx.sessionManager, selected, runtimeState(ctx)));
    } else if (mode === "tree") {
      if (ctx.sessionManager.getEntries().length === 0) {
        ctx.ui.notify("No entries in session", "warning");
        return;
      }
      const selectedEntryId = await dependencies.chooseTreeEntry(ctx);
      if (!selectedEntryId) return;
      const snapshot = captureTreeSnapshot(ctx.sessionManager, selectedEntryId, runtimeState(ctx));
      created = dependencies.createFullTree(snapshot, ctx.sessionManager);
    } else {
      created = dependencies.createFullTree(cloneSnapshot!, ctx.sessionManager);
    }

    const handoff = dependencies.createProtectedHandoff(created);
    handoffPath = handoff.path;
    const launched = await adapter.launch({
      placement,
      cwd: ctx.cwd,
      sessionPath: created.path,
      sessionId: created.sessionId,
      bootstrapPath: dependencies.bootstrapPath,
      handoffPath: handoff.path,
      handoffNonce: handoff.nonce,
      runtimeState: created.launchState,
    });
    if (!launched.ok) {
      cleanupHandoff(handoff.path);
      const cleanup = launched.cleanupError ? `; ${launched.cleanupError}` : "";
      throw new Error(`${launched.error || `${adapter.kind} launch failed`}${cleanup}`);
    }
    cleanupHandoff(handoff.path);
    handoffPath = undefined;
    const destination = placement === "horizontal"
      ? "to the right"
      : placement === "vertical"
        ? "below"
        : `in a new ${adapter.kind === "tmux" ? "window" : "tab"}`;
    ctx.ui.notify(`${displayMode(mode)} opened ${destination}; source session unchanged`, "info");
  } catch (error) {
    if (handoffPath) cleanupHandoff(handoffPath);
    ctx.ui.notify(`${displayMode(mode)} to pane failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

export function runForkToPane(
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: SessionToPaneDependencies,
): Promise<void> {
  return runToPane("fork", args, ctx, dependencies);
}

export function runTreeToPane(
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: SessionToPaneDependencies,
): Promise<void> {
  return runToPane("tree", args, ctx, dependencies);
}

export function runCloneToPane(
  args: string,
  ctx: ExtensionCommandContext,
  dependencies: SessionToPaneDependencies,
): Promise<void> {
  return runToPane("clone", args, ctx, dependencies);
}

export function createSessionToPaneExtension(
  pi: ExtensionAPI,
  overrides: Partial<SessionToPaneDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies(), ...overrides };
  const completions = (prefix: string) => ["horizontal", "vertical", "tab"]
    .filter((value) => value.startsWith(prefix.trim().toLowerCase()))
    .map((value) => ({ value, label: value }));
  pi.registerCommand("fork-to-pane", {
    description: "Fork a prompt into a new terminal pane or window",
    getArgumentCompletions: completions,
    handler: (args, ctx) => runForkToPane(args, ctx, dependencies),
  });
  pi.registerCommand("tree-to-pane", {
    description: "Copy the session tree at a selected position into a new pane",
    getArgumentCompletions: completions,
    handler: (args, ctx) => runTreeToPane(args, ctx, dependencies),
  });
  pi.registerCommand("clone-to-pane", {
    description: "Clone the complete session tree into a new pane",
    getArgumentCompletions: completions,
    handler: (args, ctx) => runCloneToPane(args, ctx, dependencies),
  });
}

export default function sessionToPaneExtension(pi: ExtensionAPI): void {
  createSessionToPaneExtension(pi);
}
