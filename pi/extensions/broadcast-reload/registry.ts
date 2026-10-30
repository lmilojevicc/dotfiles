import fs from "node:fs";
import path from "node:path";
import {
  getDefaultSocketDir,
  parsePidFromSocketPath,
  isProcessAlive,
  resolveSocketAddress,
  sendSocketMessage,
  type RequestMessage,
  type SessionResponse,
} from "./protocol.ts";

export interface HerdrPaneReload {
  paneId: string;
  cwd?: string;
  title?: string;
}

export interface HerdrSkippedPane extends HerdrPaneReload {
  status: string;
  reason: string;
}

export interface HerdrFailedPane extends HerdrPaneReload {
  error: string;
}

export interface UnreachableSession {
  pid: number;
  command?: string;
  reason: string;
}

export interface BroadcastSummary {
  totalSocketsFound: number;
  cleanedStaleSockets: string[];
  reloaded: SessionResponse[];
  queuedBusy: SessionResponse[];
  statuses: SessionResponse[];
  failed: { socketPath: string; error: string }[];
  /** Herdr fallback (plugin-less sessions): set by the caller after broadcast. */
  herdrAvailable: boolean;
  herdrError?: string;
  herdrReloaded: HerdrPaneReload[];
  herdrSkippedBusy: HerdrSkippedPane[];
  herdrSkippedUnknown: HerdrSkippedPane[];
  herdrFailed: HerdrFailedPane[];
  /** pi PIDs with no socket and no Herdr pane: need manual /reload. */
  unreachable: UnreachableSession[];
  /**
   * Process-discovery sweep: false until a scan ran successfully. A set
   * `discoveryError` means the sweep could not run at all, so `unreachable`
   * is an incomplete picture rather than proof that nothing was missed.
   */
  discoveryAvailable: boolean;
  discoveryError?: string;
}

export function listActiveSocketPaths(socketDir: string = getDefaultSocketDir()): string[] {
  if (!fs.existsSync(socketDir)) {
    return [];
  }
  try {
    const entries = fs.readdirSync(socketDir);
    return entries
      .filter((entry) => entry.endsWith(".sock"))
      .map((entry) => path.join(socketDir, entry));
  } catch {
    return [];
  }
}

export function cleanStaleSocketFile(socketPath: string): boolean {
  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
      return true;
    }
  } catch {
    // Ignore unlink failure
  }
  return false;
}

export async function broadcastToSessions(options: {
  senderPid: number;
  request: RequestMessage;
  socketDir?: string;
  timeoutMs?: number;
  checkProcessAlive?: (pid: number) => boolean;
}): Promise<BroadcastSummary> {
  const socketDir = options.socketDir ?? getDefaultSocketDir();
  const socketPaths = listActiveSocketPaths(socketDir);
  const timeoutMs = options.timeoutMs ?? 2000;
  const isAlive = options.checkProcessAlive ?? isProcessAlive;

  const summary: BroadcastSummary = {
    totalSocketsFound: socketPaths.length,
    cleanedStaleSockets: [],
    reloaded: [],
    queuedBusy: [],
    statuses: [],
    failed: [],
    herdrAvailable: false,
    herdrReloaded: [],
    herdrSkippedBusy: [],
    herdrSkippedUnknown: [],
    herdrFailed: [],
    unreachable: [],
    discoveryAvailable: false,
  };

  const tasks = socketPaths.map(async (socketPath) => {
    const pid = parsePidFromSocketPath(socketPath);

    // Skip self
    if (pid !== null && pid === options.senderPid) {
      return;
    }

    // Check if PID is still alive before connecting
    if (pid !== null && !isAlive(pid)) {
      if (cleanStaleSocketFile(socketPath)) {
        summary.cleanedStaleSockets.push(socketPath);
      }
      return;
    }

    try {
      // `socketPath` is the on-disk marker; on Windows that maps to a named pipe.
      const res = await sendSocketMessage(resolveSocketAddress(socketPath), options.request, timeoutMs);
      summary.statuses.push(res);

      if (res.status === "reloading") {
        summary.reloaded.push(res);
      } else if (res.status === "queued_busy") {
        summary.queuedBusy.push(res);
      }
    } catch (err: any) {
      const code = err?.code;
      // Stale / unconnectable socket
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        if (cleanStaleSocketFile(socketPath)) {
          summary.cleanedStaleSockets.push(socketPath);
        }
      } else {
        summary.failed.push({
          socketPath,
          error: err?.message || String(err),
        });
      }
    }
  });

  await Promise.all(tasks);
  return summary;
}
