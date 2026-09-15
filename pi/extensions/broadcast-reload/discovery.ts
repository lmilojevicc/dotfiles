import { spawnSync } from "node:child_process";

export interface PiProcess {
  pid: number;
  command: string;
}

export interface PsResult {
  ok: boolean;
  stdout: string;
  error?: string;
}

export type PsRunner = () => PsResult;

/**
 * Substrings that prove a process line is a helper rather than a pi session,
 * checked before the positive pi match. Kept narrow so real sessions
 * (including `pi -p` one-shots, which also match and are reported as manual)
 * are not filtered out.
 */
const PI_EXCLUSIONS = /pi-intercom|pi-zentui|tsx|esbuild|broker\.ts|\bherdr\b/i;

function isUnixPiCommand(command: string): boolean {
  if (PI_EXCLUSIONS.test(command)) return false;
  // Matches `pi`, `/opt/homebrew/bin/pi ...`, `node /.../bin/pi ...`.
  // Deliberately does NOT match `pinchtab`, `pi-intercom`, `pip`, etc.
  if (/(^|\/)pi(\s|$)/.test(command)) return true;
  // Matches node running the pi bundle directly.
  if (/pi-coding-agent/.test(command)) return true;
  return false;
}

/**
 * Decide whether a process command line belongs to a pi session process.
 * Conservative: unknown helpers return false.
 */
export function isPiCommand(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  if (process.platform === "win32") {
    // tasklist only yields image names; match a pi image and nothing else.
    // node.exe rows are intentionally NOT matched: without a command line
    // we cannot prove they are pi sessions (documented limitation).
    return /(^|\\)pi(\.exe)?$/i.test(trimmed);
  }
  return isUnixPiCommand(trimmed);
}

/**
 * Parse `ps -eo pid,command` output (header line optional).
 * Never throws; malformed lines are skipped.
 */
export function parsePsOutput(stdout: string): PiProcess[] {
  const processes: PiProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*\S)\s*$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    const command = match[2];
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    // Skip the header row ("PID COMMAND") and self-scan helpers.
    if (/^command$/i.test(command.trim())) continue;
    if (/\bgrep\b/.test(command)) continue;
    if (isPiCommand(command)) {
      processes.push({ pid, command });
    }
  }
  return processes;
}

/** Parse `tasklist /FO CSV /NH` output (win32 best-effort). */
export function parseTasklistOutput(stdout: string): PiProcess[] {
  const processes: PiProcess[] = [];
  for (const line of stdout.split("\n")) {
    const cells = line.match(/"([^"]*)"/g)?.map((cell) => cell.slice(1, -1));
    if (!cells || cells.length < 2) continue;
    const image = (cells[0] ?? "").trim();
    const pid = parseInt((cells[1] ?? "").trim(), 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    if (isPiCommand(image)) {
      processes.push({ pid, command: image });
    }
  }
  return processes;
}

export function defaultPsRunner(): PsResult {
  try {
    if (process.platform === "win32") {
      const res = spawnSync("tasklist", ["/FO", "CSV", "/NH"], {
        timeout: 5000,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (res.error || res.status !== 0) {
        return { ok: false, stdout: "", error: "tasklist is not available" };
      }
      return { ok: true, stdout: typeof res.stdout === "string" ? res.stdout : "" };
    }
    const res = spawnSync("ps", ["-eo", "pid,command"], {
      timeout: 5000,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (res.error || res.status !== 0) {
      return { ok: false, stdout: "", error: "ps is not available" };
    }
    return { ok: true, stdout: typeof res.stdout === "string" ? res.stdout : "" };
  } catch (err: any) {
    return { ok: false, stdout: "", error: err?.message || String(err) };
  }
}

export interface DiscoveryClient {
  listPiProcesses(): { available: boolean; processes: PiProcess[]; error?: string };
}

export function createDiscoveryClient(runner: PsRunner = defaultPsRunner): DiscoveryClient {
  function listPiProcesses(): { available: boolean; processes: PiProcess[]; error?: string } {
    const res = runner();
    if (!res.ok) {
      return { available: false, processes: [], error: res.error || "process scan failed" };
    }
    const parsed =
      process.platform === "win32" ? parseTasklistOutput(res.stdout) : parsePsOutput(res.stdout);
    return { available: true, processes: parsed };
  }
  return { listPiProcesses };
}

/**
 * Pure helper: pi processes that are neither the sender nor covered by a
 * plugin socket or a Herdr pane. These sessions cannot be reloaded from here
 * and must be reported for manual `/reload`.
 */
export function findUncoveredPiProcesses(
  processes: PiProcess[],
  coveredPids: Set<number> | number[],
  senderPid: number
): PiProcess[] {
  const covered = coveredPids instanceof Set ? coveredPids : new Set(coveredPids);
  return processes.filter((proc) => proc.pid !== senderPid && !covered.has(proc.pid));
}
