import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import {
  waitForHandoffReady,
  type HandoffReadinessExpectation,
  type HandoffReadinessResult,
} from "./handoff.ts";
import {
  buildPiCommand,
  type HostAdapter,
  type HostLaunchRequest,
  type HostLaunchResult,
  type PiLauncher,
} from "./host.ts";

export interface TmuxExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type TmuxExecFn = (args: string[], timeoutMs: number) => TmuxExecResult;

export interface TmuxSourceIdentity {
  socketPath: string;
  serverPid: string;
  paneId: string;
  sessionId: string;
  windowId: string;
}

export interface ParsedTmuxEnvironment {
  socketPath: string;
  serverPid: string;
  sessionId: string;
  paneId: string;
}

export interface TmuxAdapter extends HostAdapter {
  readonly kind: "tmux";
  validateSource(): { ok: boolean; source?: TmuxSourceIdentity; error?: string };
}

export interface TmuxAdapterOptions {
  piLauncher?: PiLauncher;
  readinessTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  waitForReady?: (
    expected: HandoffReadinessExpectation,
    timeoutMs: number,
    pollIntervalMs: number,
  ) => Promise<HandoffReadinessResult>;
}

const SOURCE_FORMAT = "#{pane_id}\t#{session_id}\t#{window_id}\t#{pid}";
const CREATED_FORMAT = "#{pane_id}\t#{session_id}\t#{window_id}";
const SERVER_MISMATCH_OUTPUT = "session-to-pane-server-identity-mismatch";
const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 50;

export function defaultTmuxExec(args: string[], timeoutMs: number): TmuxExecResult {
  try {
    const result = spawnSync("tmux", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    if (result.error) return { ok: false, stdout, stderr, error: result.error.message };
    if (result.status !== 0) return { ok: false, stdout, stderr, error: stderr.trim() || `tmux exited with status ${result.status}` };
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export function parseTmuxEnvironment(env: NodeJS.ProcessEnv):
  | { ok: true; identity: ParsedTmuxEnvironment }
  | { ok: false; error: string } {
  const tmux = env.TMUX;
  if (typeof tmux !== "string") return { ok: false, error: "tmux session identity is missing" };
  const match = /^(.+),(\d+),(\d+)$/.exec(tmux);
  if (!match || !isAbsolute(match[1])) return { ok: false, error: "tmux session identity is malformed" };
  const paneId = env.TMUX_PANE;
  if (typeof paneId !== "string" || !/^%\d+$/.test(paneId)) {
    return { ok: false, error: "tmux pane identity is missing or malformed" };
  }
  return {
    ok: true,
    identity: {
      socketPath: match[1],
      serverPid: match[2],
      sessionId: match[3],
      paneId,
    },
  };
}

function parseSourceIdentity(
  stdout: string,
  expectedPaneId: string,
  expectedSessionNumber: string,
): Omit<TmuxSourceIdentity, "socketPath"> | undefined {
  const lines = stdout.replace(/\r?\n$/, "").split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return undefined;
  const identities: Array<Omit<TmuxSourceIdentity, "socketPath">> = [];
  for (const line of lines) {
    const match = /^(%\d+)\t(\$\d+)\t(@\d+)\t(\d+)$/.exec(line);
    if (!match) return undefined;
    identities.push({ paneId: match[1], sessionId: match[2], windowId: match[3], serverPid: match[4] });
  }
  const matches = identities.filter((identity) =>
    identity.paneId === expectedPaneId &&
    numericIdsEqual(identity.sessionId.slice(1), expectedSessionNumber)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function parseCreatedIdentity(stdout: string): Pick<TmuxSourceIdentity, "paneId" | "sessionId" | "windowId"> | undefined {
  const match = /^(%\d+)\t(\$\d+)\t(@\d+)\r?\n?$/.exec(stdout);
  if (!match) return undefined;
  return { paneId: match[1], sessionId: match[2], windowId: match[3] };
}

function numericIdsEqual(left: string, right: string): boolean {
  try {
    return BigInt(left) === BigInt(right);
  } catch {
    return false;
  }
}

/** Quote one argv value for the second tmux parse performed by if-shell. */
export function quoteTmuxCommandArg(value: string): string {
  let escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("$", "\\$")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  if (escaped.startsWith("~")) escaped = `\\${escaped}`;
  return `"${escaped}"`;
}

export function serializeTmuxCommand(args: string[]): string {
  return args.map(quoteTmuxCommandArg).join(" ");
}

/** Preserve user text when tmux independently expands command option formats. */
export function escapeTmuxFormatLiteral(value: string): string {
  return value.replaceAll("#", "##");
}

export function createTmuxAdapter(
  exec: TmuxExecFn = defaultTmuxExec,
  env: NodeJS.ProcessEnv = process.env,
  options: TmuxAdapterOptions = {},
): TmuxAdapter {
  let source: TmuxSourceIdentity | undefined;

  function validateSource(): { ok: boolean; source?: TmuxSourceIdentity; error?: string } {
    source = undefined;
    const parsed = parseTmuxEnvironment(env);
    if (!parsed.ok) return parsed;
    const { socketPath, serverPid, sessionId, paneId } = parsed.identity;
    const expectedSessionId = `$${sessionId}`;
    const inspected = exec([
      "-S", socketPath,
      "list-panes", "-s", "-t", expectedSessionId, "-F", SOURCE_FORMAT,
    ], 3000);
    if (!inspected.ok) {
      return { ok: false, error: inspected.error || "Could not verify the tmux source pane" };
    }
    const identity = parseSourceIdentity(inspected.stdout, paneId, sessionId);
    if (
      !identity ||
      !numericIdsEqual(identity.serverPid, serverPid)
    ) {
      return { ok: false, error: "tmux server or pane identity does not match the current session" };
    }
    source = { socketPath, ...identity };
    return { ok: true, source };
  }

  async function launch(request: HostLaunchRequest): Promise<HostLaunchResult> {
    if (!source) return { ok: false, error: "tmux source pane was not validated" };
    const pinnedSource = source;
    const runOwnedMutation = (commandArgs: string[], timeoutMs: number): TmuxExecResult => {
      const result = exec([
        "-S", pinnedSource.socketPath,
        "if-shell", "-F", `#{==:#{pid},${pinnedSource.serverPid}}`,
        serializeTmuxCommand(commandArgs),
        serializeTmuxCommand(["display-message", "-p", SERVER_MISMATCH_OUTPUT]),
      ], timeoutMs);
      if (result.ok && result.stdout.trim() === SERVER_MISMATCH_OUTPUT) {
        return {
          ok: false,
          stdout: result.stdout,
          stderr: result.stderr,
          error: "tmux server identity changed; refused to mutate a replacement server",
        };
      }
      return result;
    };
    const commonArgs = [
      "-c", escapeTmuxFormatLiteral(request.cwd),
      "-e", `PI_SESSION_TO_PANE_HANDOFF=${request.handoffPath}`,
      "-e", `PI_SESSION_TO_PANE_NONCE=${request.handoffNonce}`,
      buildPiCommand(request.sessionPath, request.bootstrapPath, request.runtimeState, options.piLauncher),
    ];
    const sourceTarget = `${pinnedSource.sessionId}:${pinnedSource.windowId}.${pinnedSource.paneId}`;
    const creationCommand = request.placement === "tab"
      ? [
          "new-window", "-d", "-P", "-F", CREATED_FORMAT,
          "-t", `${pinnedSource.sessionId}:`,
          ...commonArgs,
        ]
      : [
          "split-window", "-d", "-P", "-F", CREATED_FORMAT,
          request.placement === "horizontal" ? "-h" : "-v",
          "-t", sourceTarget,
          ...commonArgs,
        ];
    const created = runOwnedMutation(creationCommand, 5000);
    if (!created.ok) {
      return { ok: false, error: created.error || `tmux could not create the new ${request.placement === "tab" ? "window" : "pane"}` };
    }

    const target = parseCreatedIdentity(created.stdout);
    const validTarget = target &&
      target.sessionId === pinnedSource.sessionId &&
      target.paneId !== pinnedSource.paneId &&
      (request.placement === "tab"
        ? target.windowId !== pinnedSource.windowId
        : target.windowId === pinnedSource.windowId);
    if (!validTarget || !target) {
      return { ok: false, error: `tmux returned an invalid new ${request.placement === "tab" ? "window" : "pane"} identity` };
    }

    const closeCreatedTarget = (error: string): HostLaunchResult => {
      const cleanupCommand = request.placement === "tab"
        ? ["kill-window", "-t", `${target.sessionId}:${target.windowId}`]
        : ["kill-pane", "-t", `${target.sessionId}:${target.windowId}.${target.paneId}`];
      const cleanup = runOwnedMutation(cleanupCommand, 5000);
      return {
        ok: false,
        paneId: target.paneId,
        error,
        cleanupError: cleanup.ok
          ? undefined
          : cleanup.error || `could not close the unused tmux ${request.placement === "tab" ? "window" : "pane"}`,
      };
    };

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
    if (!readiness.ok) return closeCreatedTarget(readiness.error || "Child Pi did not become ready");
    return { ok: true, paneId: target.paneId };
  }

  return { kind: "tmux", validateSource, launch };
}
