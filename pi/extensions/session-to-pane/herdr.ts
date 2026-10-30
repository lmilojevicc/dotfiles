import { spawnSync } from "node:child_process";
import {
  waitForHandoffReady,
  type HandoffReadinessExpectation,
  type HandoffReadinessResult,
} from "./handoff.ts";
import {
  buildPiCommand,
  type ForkPlacement,
  type HostAdapter,
  type HostLaunchRequest,
  type HostLaunchResult,
  type PiLauncher,
} from "./host.ts";

export type HerdrDirection = "right" | "down";

export interface HerdrExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type HerdrExecFn = (args: string[], timeoutMs: number) => HerdrExecResult;

export function defaultHerdrExec(args: string[], timeoutMs: number): HerdrExecResult {
  try {
    const result = spawnSync("herdr", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    if (result.error) return { ok: false, stdout, stderr, error: result.error.message };
    if (result.status !== 0) return { ok: false, stdout, stderr, error: stderr.trim() || `herdr exited with status ${result.status}` };
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(stdout: string): any | undefined {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

function parsePaneId(stdout: string): string | undefined {
  const parsed = parseJson(stdout);
  return nonemptyString(parsed?.result?.pane?.pane_id ?? parsed?.pane?.pane_id ?? parsed?.pane_id);
}

function parsePaneLocation(stdout: string): { paneId?: string; workspaceId?: string; tabId?: string } {
  const parsed = parseJson(stdout);
  const pane = parsed?.result?.pane ?? parsed?.pane;
  return {
    paneId: nonemptyString(pane?.pane_id),
    workspaceId: nonemptyString(pane?.workspace_id),
    tabId: nonemptyString(pane?.tab_id),
  };
}

function parseCreatedTab(stdout: string): { paneId?: string; tabId?: string } {
  const parsed = parseJson(stdout);
  return {
    paneId: nonemptyString(parsed?.result?.root_pane?.pane_id ?? parsed?.root_pane?.pane_id),
    tabId: nonemptyString(parsed?.result?.tab?.tab_id ?? parsed?.tab?.tab_id),
  };
}

export function orientationDirection(orientation: Exclude<ForkPlacement, "tab">): HerdrDirection {
  return orientation === "horizontal" ? "right" : "down";
}

export interface HerdrAdapter extends HostAdapter {
  readonly kind: "herdr";
  validateSource(): { ok: boolean; sourcePaneId?: string; error?: string };
}

export interface HerdrAdapterOptions {
  piLauncher?: PiLauncher;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  waitForReady?: (
    expected: HandoffReadinessExpectation,
    timeoutMs: number,
    pollIntervalMs: number,
  ) => Promise<HandoffReadinessResult>;
}

const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 50;

export function createHerdrAdapter(
  exec: HerdrExecFn = defaultHerdrExec,
  env: NodeJS.ProcessEnv = process.env,
  options: HerdrAdapterOptions = {},
): HerdrAdapter {
  let sourcePaneId: string | undefined;
  let sourceWorkspaceId: string | undefined;

  function validateSource(): { ok: boolean; sourcePaneId?: string; error?: string } {
    if (env.HERDR_ENV !== "1") return { ok: false, error: "This command currently requires Herdr" };
    if (!env.HERDR_SOCKET_PATH) return { ok: false, error: "Herdr session identity is missing" };
    if (!env.HERDR_PANE_ID) return { ok: false, error: "Herdr pane identity is missing" };
    if (!env.HERDR_WORKSPACE_ID || !env.HERDR_TAB_ID) return { ok: false, error: "Herdr workspace or tab identity is missing" };
    const version = exec(["--version"], 3000);
    if (!version.ok) return { ok: false, error: version.error || "Herdr CLI is unavailable" };
    const current = exec(["pane", "current", "--current"], 3000);
    if (!current.ok) return { ok: false, error: current.error || "Could not verify the current Herdr pane" };
    const currentPaneId = parsePaneId(current.stdout);
    if (!currentPaneId || currentPaneId !== env.HERDR_PANE_ID) {
      return { ok: false, error: "Herdr pane identity does not match the current session" };
    }
    const pane = exec(["pane", "get", currentPaneId], 3000);
    if (!pane.ok) return { ok: false, error: pane.error || "Could not inspect the current Herdr pane" };
    const location = parsePaneLocation(pane.stdout);
    if (
      location.paneId !== currentPaneId ||
      location.workspaceId !== env.HERDR_WORKSPACE_ID ||
      location.tabId !== env.HERDR_TAB_ID
    ) {
      return { ok: false, error: "Herdr workspace or tab identity does not match the source pane" };
    }
    sourcePaneId = currentPaneId;
    sourceWorkspaceId = location.workspaceId;
    return { ok: true, sourcePaneId };
  }

  async function launch(request: HostLaunchRequest): Promise<HostLaunchResult> {
    if (!sourcePaneId || !sourceWorkspaceId) return { ok: false, error: "Herdr source pane was not validated" };
    const commonArgs = [
      "--cwd", request.cwd,
      "--env", `PI_SESSION_TO_PANE_HANDOFF=${request.handoffPath}`,
      "--env", `PI_SESSION_TO_PANE_NONCE=${request.handoffNonce}`,
      "--no-focus",
    ];

    let paneId: string | undefined;
    let createdTabId: string | undefined;
    const closeCreatedTarget = (error: string): HostLaunchResult => {
      const closeArgs = createdTabId ? ["tab", "close", createdTabId] : ["pane", "close", paneId];
      const close = exec(closeArgs, 5000);
      return {
        ok: false,
        paneId,
        error,
        cleanupError: close.ok ? undefined : close.error || `could not close the unused ${createdTabId ? "tab" : "pane"}`,
      };
    };

    if (request.placement === "tab") {
      const created = exec(["tab", "create", "--workspace", sourceWorkspaceId, ...commonArgs], 5000);
      if (!created.ok) return { ok: false, error: created.error || "Herdr could not create a tab in the source workspace" };
      const parsed = parseCreatedTab(created.stdout);
      paneId = parsed.paneId;
      createdTabId = parsed.tabId;
      if (!paneId || !createdTabId) {
        const error = "Herdr returned an invalid new tab identity";
        // Close whatever identity Herdr did prove; only a tab or pane id can be closed.
        if (!paneId && !createdTabId) return { ok: false, error };
        return closeCreatedTarget(error);
      }
    } else {
      const split = exec([
        "pane", "split",
        "--pane", sourcePaneId,
        "--direction", orientationDirection(request.placement),
        ...commonArgs,
      ], 5000);
      if (!split.ok) return { ok: false, error: split.error || "Herdr could not split the source pane" };
      paneId = parsePaneId(split.stdout);
      if (!paneId || paneId === sourcePaneId) {
        return { ok: false, error: "Herdr returned an invalid new pane identity" };
      }
    }

    const run = exec([
      "pane", "run", paneId,
      buildPiCommand(request.sessionPath, request.bootstrapPath, request.runtimeState, options.piLauncher),
    ], 5000);
    if (!run.ok) return closeCreatedTarget(run.error || "Herdr could not launch Pi in the new pane");

    let readiness: HandoffReadinessResult;
    try {
      readiness = await (options.waitForReady ?? waitForHandoffReady)(
        {
          handoffPath: request.handoffPath,
          nonce: request.handoffNonce,
          sessionPath: request.sessionPath,
          sessionId: request.sessionId,
        },
        options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS,
      );
    } catch (error) {
      return closeCreatedTarget(`Could not verify child Pi readiness: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!readiness.ok) {
      return closeCreatedTarget(readiness.error || "Child Pi did not become ready");
    }
    return { ok: true, paneId };
  }

  return { kind: "herdr", validateSource, launch };
}
