import { spawnSync } from "node:child_process";

export type HerdrAgentStatus = "idle" | "working" | "unknown";

export interface HerdrPane {
  paneId: string;
  /** Agent detected in the pane: "pi", "cmd", ... Empty when Herdr detected none. */
  agent: string;
  agentStatus: HerdrAgentStatus;
  cwd?: string;
  title?: string;
  focused?: boolean;
}

export interface HerdrExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export type HerdrExecFn = (args: string[], timeoutMs: number) => HerdrExecResult;

export function defaultHerdrExec(args: string[], timeoutMs: number): HerdrExecResult {
  try {
    const res = spawnSync("herdr", args, {
      timeout: timeoutMs,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error) {
      return {
        ok: false,
        stdout: typeof res.stdout === "string" ? res.stdout : "",
        stderr: typeof res.stderr === "string" ? res.stderr : "",
        error: (res.error as Error)?.message || String(res.error),
      };
    }
    if (res.status !== 0) {
      const stderr = typeof res.stderr === "string" ? res.stderr : "";
      return {
        ok: false,
        stdout: typeof res.stdout === "string" ? res.stdout : "",
        stderr,
        error: stderr.trim() || `herdr exited with status ${res.status}`,
      };
    }
    return {
      ok: true,
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      stderr: typeof res.stderr === "string" ? res.stderr : "",
    };
  } catch (err: any) {
    return { ok: false, stdout: "", stderr: "", error: err?.message || String(err) };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeAgentStatus(value: unknown): HerdrAgentStatus {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "idle") return "idle";
  if (normalized === "working") return "working";
  return "unknown";
}

/**
 * Tolerant parser for `herdr pane list` output.
 * The CLI wraps panes in an envelope ({ result: { panes: [...] } }),
 * but this also accepts a bare { panes } object or a top-level array.
 * Unparseable input yields an empty list (never throws).
 */
export function parseHerdrPaneList(stdout: string): HerdrPane[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const record = parsed as Record<string, any>;
  const raw: unknown =
    record?.result?.panes ?? record?.panes ?? (Array.isArray(parsed) ? parsed : []);
  if (!Array.isArray(raw)) return [];

  const panes: HerdrPane[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, any>;
    const paneId = asString(entry.pane_id ?? entry.paneId ?? entry.id);
    if (!paneId) continue;
    panes.push({
      paneId,
      agent: asString(entry.agent) ?? "",
      agentStatus: normalizeAgentStatus(entry.agent_status ?? entry.agentStatus),
      cwd: asString(entry.cwd ?? entry.foreground_cwd),
      title: asString(entry.terminal_title_stripped ?? entry.terminal_title ?? entry.title),
      focused: typeof entry.focused === "boolean" ? entry.focused : undefined,
    });
  }
  return panes;
}

/** Parse `herdr pane current` output. Returns the pane id or undefined. */
export function parseCurrentPaneId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as Record<string, any>;
    return asString(parsed?.result?.pane?.pane_id ?? parsed?.pane?.pane_id ?? parsed?.pane_id);
  } catch {
    return undefined;
  }
}

/**
 * Parse `herdr pane process-info` output.
 * Shape: { result: { process_info: { foreground_processes: [{ pid }], ... } } }.
 * Only foreground PIDs are returned: the pi node process runs in the
 * foreground of its pane, while shell_pid is the parent shell.
 */
export function parsePanePids(stdout: string): number[] {
  try {
    const parsed = JSON.parse(stdout) as Record<string, any>;
    const info = parsed?.result?.process_info ?? parsed?.process_info;
    const procs = info?.foreground_processes;
    if (!Array.isArray(procs)) return [];
    const pids: number[] = [];
    for (const proc of procs) {
      const pid = (proc as Record<string, any>)?.pid;
      if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

export interface HerdrClient {
  isAvailable(): boolean;
  listPanes(): { available: boolean; panes: HerdrPane[]; error?: string };
  getCurrentPaneId(): { paneId?: string; error?: string };
  getPanePids(paneId: string): { pids: number[]; error?: string };
  /**
   * Fresh status read for a single pane, for the pre-injection re-check
   * (P1-1: closes the idle→working TOCTOU between selection and inject).
   */
  getPaneStatus(paneId: string): { status?: HerdrAgentStatus; error?: string };
  injectReload(paneId: string): { ok: boolean; error?: string };
}

const ENTER_KEY_CANDIDATES = ["Enter", "Return"];

function isKeyValidationError(text: string): boolean {
  return /unknown key|invalid key|not a valid key/i.test(text);
}

export function createHerdrClient(
  exec: HerdrExecFn = defaultHerdrExec,
  env: NodeJS.ProcessEnv = process.env
): HerdrClient {
  let availabilityCache: boolean | undefined;

  function isAvailable(): boolean {
    if (availabilityCache !== undefined) return availabilityCache;
    // Fail closed: only sessions running under Herdr (HERDR_ENV=1) with a
    // working CLI may inject keystrokes into other panes.
    if (env.HERDR_ENV !== "1") {
      availabilityCache = false;
      return false;
    }
    const version = exec(["--version"], 3000);
    availabilityCache = version.ok;
    return availabilityCache;
  }

  function listPanes(): { available: boolean; panes: HerdrPane[]; error?: string } {
    if (!isAvailable()) {
      return { available: false, panes: [], error: "Herdr CLI is not available" };
    }
    const res = exec(["pane", "list"], 5000);
    if (!res.ok) {
      return { available: true, panes: [], error: res.error || "herdr pane list failed" };
    }
    return { available: true, panes: parseHerdrPaneList(res.stdout) };
  }

  function getCurrentPaneId(): { paneId?: string; error?: string } {
    if (!isAvailable()) {
      return { error: "Herdr CLI is not available" };
    }
    const res = exec(["pane", "current"], 3000);
    if (!res.ok) {
      return { error: res.error || "herdr pane current failed" };
    }
    const paneId = parseCurrentPaneId(res.stdout);
    if (!paneId) {
      return { error: "Could not determine current pane id" };
    }
    return { paneId };
  }

  function getPanePids(paneId: string): { pids: number[]; error?: string } {
    if (!isAvailable()) {
      return { pids: [], error: "Herdr CLI is not available" };
    }
    const res = exec(["pane", "process-info", "--pane", paneId], 3000);
    if (!res.ok) {
      return { pids: [], error: res.error || `process-info failed for pane ${paneId}` };
    }
    return { pids: parsePanePids(res.stdout) };
  }

  function getPaneStatus(paneId: string): { status?: HerdrAgentStatus; error?: string } {
    const listed = listPanes();
    if (listed.error) {
      return { error: listed.error };
    }
    const pane = listed.panes.find((entry) => entry.paneId === paneId);
    if (!pane) {
      return { error: `Pane ${paneId} no longer listed` };
    }
    return { status: pane.agentStatus };
  }

  function sendEscapeCleanup(paneId: string): string {
    // Best-effort: clear the typed-but-unsubmitted "/reload" so a stray
    // command line is not left sitting in a foreign pane's editor.
    // "esc" is the canonical Escape key name for `herdr pane send-keys`.
    const res = exec(["pane", "send-keys", paneId, "esc"], 5000);
    if (res.ok) return "cleanup Escape sent";
    return `cleanup Escape failed (${res.error || "unknown error"})`;
  }

  function injectReload(paneId: string): { ok: boolean; error?: string } {
    if (!isAvailable()) {
      return { ok: false, error: "Herdr CLI is not available" };
    }
    // Type the literal command first, then submit it. These are two ordered
    // writes to the same pane pty. If the submit half fails, the "/reload"
    // text is left typed-but-unsubmitted in a foreign pane, so attempt an
    // Escape cleanup and report its outcome alongside the failure.
    const text = exec(["pane", "send-text", paneId, "/reload"], 5000);
    if (!text.ok) {
      return { ok: false, error: text.error || `send-text failed for pane ${paneId}` };
    }
    for (const key of ENTER_KEY_CANDIDATES) {
      const res = exec(["pane", "send-keys", paneId, key], 5000);
      if (res.ok) return { ok: true };
      const detail = `${res.stderr ?? ""} ${res.error ?? ""}`;
      if (isKeyValidationError(detail)) continue; // Try the next key name.
      const cleanup = sendEscapeCleanup(paneId);
      return {
        ok: false,
        error: `${res.error || `send-keys failed for pane ${paneId}`}; ${cleanup}`,
      };
    }
    const cleanup = sendEscapeCleanup(paneId);
    return {
      ok: false,
      error: `send-keys rejected Enter key for pane ${paneId}; ${cleanup}`,
    };
  }

  return { isAvailable, listPanes, getCurrentPaneId, getPanePids, getPaneStatus, injectReload };
}

export interface PaneSelectionOptions {
  senderPid: number;
  selfPaneId?: string;
  coveredPids: Set<number> | number[];
  /** Pane id -> foreground PIDs from process-info. Missing entry = unknown. */
  panePids: Map<string, number[]> | Record<string, number[]>;
}

export interface SkippedPane {
  pane: HerdrPane;
  reason: string;
}

export interface PaneSelection {
  /** Idle pi panes with no plugin socket: safe to inject into. */
  toReload: HerdrPane[];
  /** Panes whose PID is covered by a plugin socket: already handled. */
  alreadyCovered: HerdrPane[];
  skippedSelf: HerdrPane[];
  skippedBusy: SkippedPane[];
  skippedUnknown: SkippedPane[];
  notPi: HerdrPane[];
}

function lookupPids(
  panePids: Map<string, number[]> | Record<string, number[]>,
  paneId: string
): { known: boolean; pids: number[] } {
  if (panePids instanceof Map) {
    const pids = panePids.get(paneId);
    if (!pids || pids.length === 0) return { known: false, pids: [] };
    return { known: true, pids };
  }
  const pids = (panePids as Record<string, number[]>)[paneId];
  if (!Array.isArray(pids) || pids.length === 0) return { known: false, pids: [] };
  return { known: true, pids };
}

/**
 * Pure classifier: decide per-pane what the Herdr fallback may do.
 * Never performs I/O. Injection safety rules live here:
 * - non-pi panes are ignored,
 * - the sender pane / sender PID is never a reload candidate,
 * - only idle panes with no plugin socket become candidates.
 */
export function selectPanesForReload(
  panes: HerdrPane[],
  options: PaneSelectionOptions
): PaneSelection {
  const coveredPidSet =
    options.coveredPids instanceof Set ? options.coveredPids : new Set(options.coveredPids);

  const selection: PaneSelection = {
    toReload: [],
    alreadyCovered: [],
    skippedSelf: [],
    skippedBusy: [],
    skippedUnknown: [],
    notPi: [],
  };

  for (const pane of panes) {
    if (pane.agent !== "pi") {
      selection.notPi.push(pane);
      continue;
    }
    if (options.selfPaneId && pane.paneId === options.selfPaneId) {
      selection.skippedSelf.push(pane);
      continue;
    }

    const { known, pids } = lookupPids(options.panePids, pane.paneId);
    if (pids.includes(options.senderPid)) {
      selection.skippedSelf.push(pane);
      continue;
    }
    if (known && pids.some((pid) => coveredPidSet.has(pid))) {
      selection.alreadyCovered.push(pane);
      continue;
    }

    if (!known) {
      // PID unknown and no corroborating evidence: never assume coverage.
      // A duplicate /reload into an idle pane is harmless; silently missing
      // a session (e.g. twin sessions in the same repo, one with the plugin
      // and one without) is not. Route to manual /reload.
      selection.skippedUnknown.push({
        pane,
        reason: "Pane process could not be correlated to a plugin session; manual /reload needed",
      });
      continue;
    }

    if (pane.agentStatus === "idle") {
      selection.toReload.push(pane);
    } else if (pane.agentStatus === "working") {
      selection.skippedBusy.push({
        pane,
        reason: "Agent is working; injecting /reload would pollute its LLM context",
      });
    } else {
      selection.skippedUnknown.push({
        pane,
        reason: "Agent status is unknown; cannot prove the session is idle",
      });
    }
  }

  return selection;
}
