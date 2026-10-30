import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createSessionServer,
  getDefaultSocketDir,
  getSocketMarkerPath,
  getSocketPath,
  type RequestMessage,
  type SessionResponse,
} from "./protocol.ts";
import {
  broadcastToSessions,
  type BroadcastSummary,
} from "./registry.ts";
import {
  createHerdrClient,
  selectPanesForReload,
  type HerdrClient,
  type HerdrPane,
  type PaneSelection,
} from "./herdr.ts";
import {
  createDiscoveryClient,
  findUncoveredPiProcesses,
  type DiscoveryClient,
} from "./discovery.ts";

export interface BroadcastReloadOptions {
  socketDir?: string;
  /**
   * Herdr integration for plugin-less sessions. `undefined` uses the real
   * client; `null` disables the Herdr fallback (socket-only behavior).
   */
  herdr?: HerdrClient | null;
  /** Process discovery for unreachable sessions. `null` disables the sweep. */
  discovery?: DiscoveryClient | null;
}

export interface ExtensionState {
  activeCtx?: ExtensionContext;
  activeSessionId?: string;
  activeCwd: string;
  isAgentRunning: boolean;
  pendingReload: boolean;
  serverCleanup?: () => void;
  exitHandler?: () => void;
}

export function createBroadcastReloadExtension(
  pi: ExtensionAPI,
  options?: BroadcastReloadOptions
): void {
  const socketDir = options?.socketDir ?? getDefaultSocketDir();
  const socketPath = getSocketPath(process.pid, socketDir);

  const state: ExtensionState = {
    activeCtx: undefined,
    activeSessionId: undefined,
    activeCwd: process.cwd(),
    isAgentRunning: false,
    pendingReload: false,
    serverCleanup: undefined,
    exitHandler: undefined,
  };

  /**
   * What Pi's own reload requires before it will act: no active run, no
   * compaction, nothing queued. `handleReloadCommand` refuses otherwise and
   * resolves normally, so this must be the last check before `ctx.reload()`.
   */
  function canReloadNow(ctx?: ExtensionContext): boolean {
    if (!ctx) return false;
    if (!ctx.isIdle()) return false;
    if (ctx.hasPendingMessages()) return false;
    return true;
  }

  function isSafeToReload(ctx?: ExtensionContext): boolean {
    if (state.isAgentRunning) return false;
    return canReloadNow(ctx);
  }

  /**
   * Remember a reload request for a busy session. Pi declines a reload while
   * the session streams or compacts, so the request is applied from
   * `agent_settled` instead of being reported as done now.
   */
  function queueReload(ctx: ExtensionContext | undefined, reason: string): void {
    const alreadyQueued = state.pendingReload;
    state.pendingReload = true;
    if (!alreadyQueued) {
      ctx?.ui?.notify?.(
        `Broadcast reload queued: ${reason}. It will reload once the current task settles.`,
        "info"
      );
    }
  }

  function triggerLocalReload(): void {
    try {
      pi.sendUserMessage("/_broadcast_reload_apply", { expandPromptTemplates: true });
    } catch (err) {
      console.error("[broadcast-reload] Failed to trigger local reload:", err);
    }
  }

  function handleIncomingRequest(msg: RequestMessage): SessionResponse {
    const ctx = state.activeCtx;
    const safe = isSafeToReload(ctx);

    if (msg.type === "ping") {
      return {
        ok: true,
        pid: process.pid,
        sessionId: state.activeSessionId,
        cwd: state.activeCwd,
        status: safe ? "idle" : "busy",
      };
    }

    if (msg.type === "status") {
      return {
        ok: true,
        pid: process.pid,
        sessionId: state.activeSessionId,
        cwd: state.activeCwd,
        status: safe ? "idle" : "busy",
        reason: safe
          ? "Agent is idle"
          : state.isAgentRunning
            ? "Agent is currently running"
            : "Session has pending messages or is not idle",
      };
    }

    if (msg.type === "reload") {
      if (!safe) {
        // Busy sessions are always queued, even when the sender forced the
        // request: Pi refuses to reload while streaming/compacting and
        // resolves anyway, so an immediate "reloading" would be lost.
        const busyReason = state.isAgentRunning
          ? "agent run in progress"
          : "pending messages or non-idle state";
        queueReload(ctx, busyReason);
        return {
          ok: true,
          pid: process.pid,
          sessionId: state.activeSessionId,
          cwd: state.activeCwd,
          status: "queued_busy",
          reason: msg.force
            ? `Reload forced while ${busyReason}; queued until the session settles`
            : busyReason,
        };
      }

      // Safe to reload now: idle sessions accept the reload synchronously.
      setImmediate(() => {
        triggerLocalReload();
      });

      return {
        ok: true,
        pid: process.pid,
        sessionId: state.activeSessionId,
        cwd: state.activeCwd,
        status: "reloading",
        reason: "Agent is idle",
      };
    }

    return {
      ok: false,
      pid: process.pid,
      cwd: state.activeCwd,
      status: "error",
      reason: "Unknown request type",
    };
  }

  function startServer(): void {
    stopServer();

    // A failed listen must not crash Pi: warn once and run without IPC. Peers
    // then see this session as unreachable and report it for manual /reload.
    const { cleanup } = createSessionServer(socketPath, handleIncomingRequest, {
      // On Windows the socket is a named pipe, which has no directory entry, so
      // a `<pid>.sock` marker keeps peer discovery and liveness checks working.
      markerPath: getSocketMarkerPath(process.pid, socketDir),
      onError: (error) => {
        console.error(`[broadcast-reload] IPC disabled for this session: ${error.message}`);
        state.activeCtx?.ui?.notify?.(
          `Broadcast reload IPC unavailable for this session (${error.message}); other sessions cannot reload it.`,
          "warning"
        );
      },
    });
    state.serverCleanup = cleanup;

    state.exitHandler = () => {
      cleanup();
    };
    process.on("exit", state.exitHandler);
  }

  function stopServer(): void {
    if (state.exitHandler) {
      process.off("exit", state.exitHandler);
      state.exitHandler = undefined;
    }
    if (state.serverCleanup) {
      state.serverCleanup();
      state.serverCleanup = undefined;
    }
  }

  function getHerdrClient(): HerdrClient | null {
    if (options?.herdr === null) return null;
    return options?.herdr ?? createHerdrClient();
  }

  function getDiscoveryClient(): DiscoveryClient | null {
    if (options?.discovery === null) return null;
    return options?.discovery ?? createDiscoveryClient();
  }

  function toPaneRef(pane: HerdrPane): { paneId: string; cwd?: string; title?: string } {
    return { paneId: pane.paneId, cwd: pane.cwd, title: pane.title };
  }

  function truncateCommand(command: string, maxLength: number = 80): string {
    const singleLine = command.replace(/\s+/g, " ").trim();
    return singleLine.length > maxLength
      ? `${singleLine.slice(0, maxLength - 1)}…`
      : singleLine;
  }

  interface HerdrCollection {
    client: HerdrClient;
    piPanes: HerdrPane[];
    panePids: Map<string, number[]>;
    selection: PaneSelection;
    selfPaneId?: string;
    selfUnresolved: boolean;
  }

  /**
   * List Herdr pi panes and classify them against socket-covered sessions.
   * Read-only: never injects. Records skip outcomes into the summary; the
   * caller decides what to do with `selection.toReload` (including a fresh
   * per-pane status re-check immediately before each injection).
   * Returns null only when Herdr is unavailable or listing failed; a
   * successful scan with zero panes yields an (empty) collection.
   */
  function collectHerdrSelection(summary: BroadcastSummary): HerdrCollection | null {
    const client = getHerdrClient();
    if (!client || !client.isAvailable()) return null;
    summary.herdrAvailable = true;

    const listed = client.listPanes();
    if (listed.error) {
      summary.herdrError = listed.error;
      return null;
    }
    const piPanes = listed.panes.filter((pane) => pane.agent === "pi");
    if (piPanes.length === 0) {
      return {
        client,
        piPanes,
        panePids: new Map(),
        selection: selectPanesForReload([], {
          senderPid: process.pid,
          coveredPids: [],
          panePids: {},
        }),
        selfPaneId: undefined,
        selfUnresolved: false,
      };
    }

    const selfPane = client.getCurrentPaneId();
    const coveredPids = new Set<number>([process.pid]);
    for (const status of summary.statuses) coveredPids.add(status.pid);

    const panePids = new Map<string, number[]>();
    for (const pane of piPanes) {
      const info = client.getPanePids(pane.paneId);
      if (!info.error) panePids.set(pane.paneId, info.pids);
    }

    const selection = selectPanesForReload(piPanes, {
      senderPid: process.pid,
      selfPaneId: selfPane.paneId,
      coveredPids,
      panePids,
    });

    summary.herdrSkippedBusy.push(
      ...selection.skippedBusy.map(({ pane, reason }) => ({
        ...toPaneRef(pane),
        status: pane.agentStatus,
        reason,
      }))
    );
    summary.herdrSkippedUnknown.push(
      ...selection.skippedUnknown.map(({ pane, reason }) => ({
        ...toPaneRef(pane),
        status: pane.agentStatus,
        reason,
      }))
    );

    return {
      client,
      piPanes,
      panePids,
      selection,
      selfPaneId: selfPane.paneId,
      selfUnresolved: !selfPane.paneId,
    };
  }

  /**
   * Sweep for pi processes with no socket and no Herdr pane. Read-only:
   * these sessions cannot be reloaded from here and are reported for
   * manual `/reload`. When some Herdr panes could not be PID-correlated,
   * a sweep hit may be the same session as a pane already listed above,
   * so it is labeled ambiguous instead of being reported as a second,
   * distinct session.
   */
  function runDiscoverySweep(
    summary: BroadcastSummary,
    extraKnownPids: number[],
    unknownPaneRefs: { paneId: string; cwd?: string }[] = []
  ): void {
    const client = getDiscoveryClient();
    if (!client) return;
    const scanned = client.listPiProcesses();
    summary.discoveryAvailable = scanned.available;
    if (!scanned.available) {
      // The sweep is the only layer that finds pi sessions without a socket
      // and without a Herdr pane. Losing it silently would report a complete
      // picture of unreachable sessions that is not complete.
      summary.discoveryError = scanned.error || "process scan failed";
      return;
    }
    summary.discoveryError = undefined;
    const known = new Set<number>([process.pid, ...extraKnownPids]);
    for (const status of summary.statuses) known.add(status.pid);
    const ambiguous =
      unknownPaneRefs.length > 0
        ? ` (may be Herdr pane ${unknownPaneRefs.map((pane) => pane.paneId).join(", ")} listed above; pane correlation failed)`
        : "";
    for (const proc of findUncoveredPiProcesses(scanned.processes, known, process.pid)) {
      summary.unreachable.push({
        pid: proc.pid,
        command: proc.command,
        reason: `No plugin socket and no matching Herdr pane${ambiguous} — manual /reload needed`,
      });
    }
  }

  /** Panes in the collection whose process could not be PID-correlated. */
  function unknownPidPaneRefs(
    collection: HerdrCollection | null
  ): { paneId: string; cwd?: string }[] {
    if (!collection) return [];
    return collection.piPanes
      .filter((pane) => {
        const pids = collection.panePids.get(pane.paneId);
        return !pids || pids.length === 0;
      })
      .map(toPaneRef);
  }

  function formatHerdrStatusLines(
    collection: HerdrCollection | null,
    herdrError?: string
  ): string[] {
    if (!collection) {
      return [
        `• Herdr pane scan: unavailable${herdrError ? ` (${herdrError})` : " (socket sessions only)"}.`,
      ];
    }
    const lines = [`• Herdr pi panes:`];
    if (collection.piPanes.length === 0) {
      lines.push(`  none detected.`);
      return lines;
    }
    const inList = (pane: HerdrPane, list: HerdrPane[]): boolean =>
      list.some((entry) => entry.paneId === pane.paneId);
    for (const pane of collection.piPanes) {
      let plugin: string;
      if (inList(pane, collection.selection.alreadyCovered)) {
        plugin = "plugin: yes (socket)";
      } else if (inList(pane, collection.selection.skippedSelf)) {
        plugin = "this session";
      } else if (inList(pane, collection.selection.toReload)) {
        plugin = "plugin: no (idle, would reload)";
      } else if (
        collection.selection.skippedBusy.some((entry) => entry.pane.paneId === pane.paneId)
      ) {
        plugin = "plugin: no (working, manual)";
      } else {
        plugin = "plugin: no (unknown, manual)";
      }
      lines.push(`  ${pane.paneId} [${pane.cwd ?? "unknown"}]: ${pane.agentStatus}, ${plugin}`);
    }
    if (collection.selfUnresolved) {
      lines.push(`  Note: sender pane unresolvable; reload would refuse blind injection.`);
    }
    return lines;
  }

  /** Scan layers that could not run, so their blind spots are never hidden. */
  function scanWarnings(summary: BroadcastSummary): string[] {
    const warnings: string[] = [];
    if (summary.herdrAvailable && summary.herdrError) {
      warnings.push(
        `Herdr fallback unavailable (${summary.herdrError}); plugin-less sessions were not reached.`
      );
    }
    if (summary.discoveryError) {
      warnings.push(
        `process sweep unavailable (${summary.discoveryError}); pi sessions without a socket or Herdr pane were not detected.`
      );
    }
    return warnings;
  }

  function composeReloadMessage(summary: BroadcastSummary, isForce: boolean): string {
    const scope: string[] = [];
    const pluginParts: string[] = [];
    if (summary.reloaded.length > 0) {
      pluginParts.push(`${summary.reloaded.length} reloaded`);
    }
    if (summary.queuedBusy.length > 0) {
      pluginParts.push(`${summary.queuedBusy.length} queued (busy)`);
    }
    if (pluginParts.length > 0) {
      scope.push(`plugin: ${pluginParts.join(", ")}`);
    }

    const herdrParts: string[] = [];
    if (summary.herdrReloaded.length > 0) {
      herdrParts.push(
        `${summary.herdrReloaded.length} plugin-less session(s) reloaded via Herdr pane input`
      );
    }
    if (summary.herdrSkippedBusy.length > 0) {
      herdrParts.push(
        `${summary.herdrSkippedBusy.length} working (skipped; re-run when idle)`
      );
    }
    if (summary.herdrSkippedUnknown.length > 0) {
      herdrParts.push(`${summary.herdrSkippedUnknown.length} unknown (manual /reload)`);
    }
    if (summary.herdrFailed.length > 0) {
      herdrParts.push(`${summary.herdrFailed.length} injection failed (manual /reload)`);
    }
    if (herdrParts.length > 0) {
      scope.push(`Herdr: ${herdrParts.join("; ")}`);
    }

    if (summary.unreachable.length > 0) {
      const pids = summary.unreachable.map((entry) => `PID ${entry.pid}`).join(", ");
      scope.push(`manual /reload needed: ${pids}`);
    }

    const warnings = scanWarnings(summary);
    const warningText = warnings.length > 0 ? ` ⚠️ ${warnings.join(" ")}` : "";
    if (scope.length === 0) {
      return `No other active pi sessions found.${warningText}`;
    }
    const forceNote =
      isForce &&
      (summary.herdrSkippedBusy.length > 0 || summary.herdrSkippedUnknown.length > 0)
        ? " Note: --force never injects into working/unknown Herdr panes."
        : "";
    return `Broadcasted reload to other session(s) (${scope.join(" | ")}).${forceNote}${warningText}`;
  }

  // Internal command executed via sendUserMessage to gain ExtensionCommandContext
  pi.registerCommand("_broadcast_reload_apply", {
    description: "Internal command to trigger local runtime reload",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // Re-check what Pi's reload requires right before asking for it: the run
      // may have started between the request and this dispatch, and Pi declines
      // a reload during a run (it warns and resolves), so an unguarded
      // ctx.reload() would silently drop the request.
      if (!canReloadNow(ctx)) {
        queueReload(ctx, "the session became busy before the reload could run");
        return;
      }
      state.pendingReload = false;
      await ctx.reload();
    },
  });

  // User-facing command
  pi.registerCommand("broadcast-reload", {
    description: "Safely reload all active pi sessions without breaking running agents",
    handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
      const args = rawArgs.trim().split(/\s+/).filter(Boolean);
      const isHelp = args.includes("--help") || args.includes("-h") || args.includes("help");
      const isStatus = args.includes("--status") || args.includes("-s") || args.includes("status");
      const isForce = args.includes("--force") || args.includes("-f") || args.includes("force");

      if (isHelp) {
        const helpText = [
          "Broadcast Reload - Safe cross-session reload for Pi",
          "",
          "Usage:",
          "  /broadcast-reload          Safely reload all active sessions (defers busy agents)",
          "                             Also reaches sessions without this plugin via Herdr pane input (idle panes only)",
          "  /broadcast-reload --status Check status of all active sessions without reloading",
          "  /broadcast-reload --force  Reload the current session even while it is busy",
          "                             Busy plugin sessions are queued and reload when they settle",
          "                             (never force-injects working/unknown Herdr panes)",
          "  /broadcast-reload --help   Show this help message",
        ].join("\n");
        ctx.ui?.notify?.(helpText, "info");
        return;
      }

      if (isStatus) {
        const summary = await broadcastToSessions({
          senderPid: process.pid,
          request: { type: "status", senderPid: process.pid },
          socketDir,
        });
        const herdr = collectHerdrSelection(summary);
        runDiscoverySweep(
          summary,
          herdr ? [...herdr.panePids.values()].flat() : [],
          unknownPidPaneRefs(herdr)
        );

        const lines: string[] = [
          `Active Pi Sessions Status:`,
          `• Current Session (PID ${process.pid}): ${isSafeToReload(ctx) ? "idle (ready)" : "busy"} [${ctx.cwd}]`,
        ];

        if (summary.statuses.length === 0) {
          lines.push(`• No other plugin sessions (sockets) detected.`);
        } else {
          lines.push(`• Plugin sessions (socket):`);
          for (const s of summary.statuses) {
            lines.push(`  PID ${s.pid}: ${s.status} [${s.cwd ?? "unknown"}]${s.reason ? ` (${s.reason})` : ""}`);
          }
        }

        lines.push(...formatHerdrStatusLines(herdr, summary.herdrError));

        if (summary.discoveryError) {
          lines.push(
            `• Process sweep: unavailable (${summary.discoveryError}); pi sessions without a socket or Herdr pane were not detected.`
          );
        }

        if (summary.unreachable.length > 0) {
          lines.push(`• Other pi processes without plugin or Herdr pane (manual /reload):`);
          for (const entry of summary.unreachable) {
            lines.push(
              `  PID ${entry.pid}${entry.command ? ` (${truncateCommand(entry.command)})` : ""}: ${entry.reason}`
            );
          }
        }

        if (summary.cleanedStaleSockets.length > 0) {
          lines.push(`🧹 Cleaned up ${summary.cleanedStaleSockets.length} stale socket(s).`);
        }

        if (summary.failed.length > 0) {
          lines.push(`⚠️ ${summary.failed.length} session(s) failed to respond.`);
        }

        const fullStatus = lines.join("\n");
        ctx.ui?.notify?.(fullStatus, "info");
        return;
      }

      // Check current session safety if not forcing
      if (!isSafeToReload(ctx) && !isForce) {
        ctx.ui?.notify?.(
          "Current session has an active agent task. Wait for it to complete or use /broadcast-reload --force.",
          "warning"
        );
        return;
      }

      // Broadcast reload to plugin sessions via sockets
      const summary = await broadcastToSessions({
        senderPid: process.pid,
        request: {
          type: "reload",
          senderPid: process.pid,
          senderSessionId: state.activeSessionId,
          force: isForce,
        },
        socketDir,
      });

      // Fallback: idle Herdr panes without the plugin get /reload typed in.
      // Working/unknown panes are never injected into, even with --force.
      // Each candidate is re-checked immediately before its injection: a pane
      // that was idle at scan time may have started streaming since, and
      // injecting /reload there would pollute its LLM context.
      const herdr = collectHerdrSelection(summary);
      if (herdr && herdr.selection.toReload.length > 0) {
        if (herdr.selfUnresolved) {
          summary.herdrSkippedUnknown.push(
            ...herdr.selection.toReload.map((pane) => ({
              ...toPaneRef(pane),
              status: pane.agentStatus,
              reason:
                "Sender pane could not be identified; refusing blind injection (manual /reload)",
            }))
          );
        } else {
          for (const pane of herdr.selection.toReload) {
            const fresh = herdr.client.getPaneStatus(pane.paneId);
            if (fresh.error || fresh.status !== "idle") {
              summary.herdrSkippedUnknown.push({
                ...toPaneRef(pane),
                status: fresh.status ?? "unknown",
                reason: fresh.error
                  ? `Pre-injection status re-check failed (${fresh.error}); manual /reload`
                  : `Pane left idle state (now ${fresh.status}); re-run /broadcast-reload once it settles`,
              });
              continue;
            }
            const res = herdr.client.injectReload(pane.paneId);
            if (res.ok) {
              summary.herdrReloaded.push(toPaneRef(pane));
            } else {
              summary.herdrFailed.push({
                ...toPaneRef(pane),
                error: res.error ?? "injection failed",
              });
            }
          }
        }
      }

      // Sweep: pi processes with no socket and no Herdr pane stay manual.
      runDiscoverySweep(
        summary,
        herdr ? [...herdr.panePids.values()].flat() : [],
        unknownPidPaneRefs(herdr)
      );

      // Reload current session. Re-check what Pi's reload requires: the socket
      // broadcast and the Herdr/ps scans above can take seconds while the TUI
      // stays interactive, and Pi declines a reload during an active run. A
      // declined reload must be queued, not reported as one that happened.
      const summaryText = composeReloadMessage(summary, isForce);
      if (!canReloadNow(ctx)) {
        ctx.ui?.notify?.(
          `${summaryText} Current session became busy; its reload is queued and will apply once the current task settles.`,
          "warning"
        );
        state.pendingReload = true;
        return;
      }
      ctx.ui?.notify?.(`${summaryText} Reloading current session...`, "info");
      await ctx.reload();
    },
  });

  // Lifecycle events
  pi.on("session_start", async (_event, ctx) => {
    state.activeCtx = ctx;
    state.activeCwd = ctx.cwd ?? process.cwd();
    try {
      state.activeSessionId = ctx.sessionManager?.getSessionId?.();
    } catch {
      state.activeSessionId = undefined;
    }
    startServer();
  });

  pi.on("session_shutdown", async () => {
    stopServer();
    state.activeCtx = undefined;
    state.isAgentRunning = false;
    state.pendingReload = false;
  });

  pi.on("agent_start", async () => {
    state.isAgentRunning = true;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    state.isAgentRunning = false;
    state.activeCtx = ctx;

    // Check if there is a pending reload queued while we were busy
    if (state.pendingReload) {
      if (canReloadNow(ctx)) {
        state.pendingReload = false;
        ctx?.ui?.notify?.("Agent task settled. Applying queued broadcast reload...", "info");
        triggerLocalReload();
      }
    }
  });
}

export default function broadcastReloadExtension(pi: ExtensionAPI): void {
  createBroadcastReloadExtension(pi);
}
