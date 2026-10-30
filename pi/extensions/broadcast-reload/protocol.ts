import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ReloadRequest {
  type: "reload";
  senderPid: number;
  senderSessionId?: string;
  force?: boolean;
}

export interface StatusRequest {
  type: "status";
  senderPid?: number;
}

export interface PingRequest {
  type: "ping";
}

export type RequestMessage = ReloadRequest | StatusRequest | PingRequest;

export type SessionState = "idle" | "busy" | "reloading" | "queued_busy" | "error";

export interface SessionResponse {
  ok: boolean;
  pid: number;
  sessionId?: string;
  cwd?: string;
  status: SessionState;
  reason?: string;
}

export function getDefaultSocketDir(): string {
  if (process.env.PI_BROADCAST_RELOAD_DIR) {
    return process.env.PI_BROADCAST_RELOAD_DIR;
  }
  return path.join(os.homedir(), ".pi", "agent", "broadcast-reload", "sockets");
}

export function getSocketPath(
  pid: number,
  socketDir: string = getDefaultSocketDir(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === "win32") {
    return `\\\\.\\pipe\\pi-broadcast-reload-${pid}`;
  }
  return path.join(socketDir, `${pid}.sock`);
}

/**
 * The on-disk marker a session publishes inside `socketDir`. On POSIX this is
 * the socket file itself; on Windows the named pipe has no directory entry, so
 * the session writes `<pid>.sock` next to it. Peer discovery, the PID liveness
 * check and stale cleanup all work off these markers on every platform, and
 * `socketDir` / `PI_BROADCAST_RELOAD_DIR` keep applying.
 */
export function getSocketMarkerPath(
  pid: number,
  socketDir: string = getDefaultSocketDir()
): string {
  return path.join(socketDir, `${pid}.sock`);
}

/** Connectable address for a marker path found on disk. */
export function resolveSocketAddress(
  markerPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform !== "win32") return markerPath;
  const pid = parsePidFromSocketPath(markerPath);
  if (pid === null) return markerPath;
  return getSocketPath(pid, path.dirname(markerPath), platform);
}

export function parsePidFromSocketPath(socketPath: string): number | null {
  const match = path.basename(socketPath).match(/^(\d+)\.sock$/);
  if (match) {
    const pid = parseInt(match[1], 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  }
  return null;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

export function sendSocketMessage(
  socketPath: string,
  message: RequestMessage,
  timeoutMs: number = 2000
): Promise<SessionResponse> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    let finished = false;
    let buffer = "";

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      finished = true;
    };

    const client = net.createConnection(socketPath);

    timer = setTimeout(() => {
      cleanup();
      client.destroy();
      const err = new Error(`Connection to ${socketPath} timed out after ${timeoutMs}ms`);
      (err as any).code = "ETIMEDOUT";
      reject(err);
    }, timeoutMs);
    timer.unref?.();

    client.on("connect", () => {
      client.write(JSON.stringify(message) + "\n");
    });

    client.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        cleanup();
        client.end();
        try {
          const parsed = JSON.parse(buffer.slice(0, newlineIndex));
          resolve(parsed as SessionResponse);
        } catch (err) {
          reject(new Error(`Invalid JSON response from ${socketPath}: ${err}`));
        }
      }
    });

    client.on("error", (err) => {
      if (!finished) {
        cleanup();
        reject(err);
      }
    });

    client.on("end", () => {
      if (!finished) {
        cleanup();
        if (buffer.trim().length > 0) {
          try {
            const parsed = JSON.parse(buffer.trim());
            resolve(parsed as SessionResponse);
            return;
          } catch {
            // Ignore, proceed to rejection
          }
        }
        reject(new Error(`Connection closed before response received from ${socketPath}`));
      }
    });
  });
}

export interface SessionServerOptions {
  /**
   * Called at most once when the session server cannot be used: the listen
   * failed (EADDRINUSE, EACCES, ENAMETOOLONG on a long macOS sun_path, ...) or
   * the directory/socket file could not be prepared. IPC stays disabled for
   * the session; the caller decides how to warn the user.
   */
  onError?: (error: Error) => void;
  /**
   * Marker file to publish in `socketDir` for peer discovery (Windows named
   * pipes have no directory entry). Defaults to the socket path itself, which
   * is already the marker on POSIX.
   */
  markerPath?: string;
}

export function createSessionServer(
  socketPath: string,
  onRequest: (msg: RequestMessage) => Promise<SessionResponse> | SessionResponse,
  options: SessionServerOptions = {}
): { server: net.Server; cleanup: () => void } {
  let reportedError = false;
  const reportError = (cause: unknown) => {
    if (reportedError) return;
    reportedError = true;
    const error = cause instanceof Error ? cause : new Error(String(cause));
    try {
      options.onError?.(error);
    } catch {
      // A throwing handler must not turn a degraded socket into a crash.
    }
  };

  // Prepare the discovery marker's directory and drop a stale marker/socket
  // file. On Windows the marker is a separate file and the socket is a named
  // pipe; on POSIX the socket file itself is the marker. Failures here are
  // reported, not thrown: a broken socket directory must degrade Pi to
  // socket-less operation instead of killing the process at session_start.
  const markerPath = options.markerPath;
  const publishesMarker = markerPath !== undefined && markerPath !== socketPath;
  let ownsSocketFile = false;
  let markerWritten = false;

  const removeMarker = () => {
    if (!markerWritten || !markerPath) return;
    markerWritten = false;
    try {
      if (fs.existsSync(markerPath)) fs.unlinkSync(markerPath);
    } catch {
      // Ignore unlink error
    }
  };

  try {
    const dir = path.dirname(publishesMarker ? (markerPath as string) : socketPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    if (publishesMarker && markerPath) {
      // Clean up a dead marker if the file exists
      if (fs.existsSync(markerPath)) {
        try {
          fs.unlinkSync(markerPath);
        } catch {
          // Ignore unlink error
        }
      }
      fs.writeFileSync(markerPath, `${process.pid}\n`, { mode: 0o600 });
      markerWritten = true;
    } else if (process.platform !== "win32") {
      // Clean up dead socket if file exists
      if (fs.existsSync(socketPath)) {
        try {
          fs.unlinkSync(socketPath);
        } catch {
          // Ignore unlink error
        }
      }
    }
  } catch (err) {
    reportError(err);
  }

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        try {
          const msg = JSON.parse(line) as RequestMessage;
          const res = await onRequest(msg);
          if (!socket.destroyed) {
            socket.write(JSON.stringify(res) + "\n", () => {
              socket.end();
            });
          }
        } catch (err: any) {
          if (!socket.destroyed) {
            const errRes: SessionResponse = {
              ok: false,
              pid: process.pid,
              status: "error",
              reason: err?.message || String(err),
            };
            socket.write(JSON.stringify(errRes) + "\n", () => {
              socket.end();
            });
          }
        }
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  });

  // A listen failure emits 'error' on the server. Without this listener Node
  // raises an uncaught exception and the whole Pi process dies, so report it
  // once and leave IPC disabled for this session.
  server.on("error", (err) => {
    reportError(err);
    // The listener is unusable: do not leave a marker behind that makes peers
    // believe this session is reachable.
    removeMarker();
    try {
      server.close();
    } catch {
      // Ignore close error
    }
  });

  server.listen(socketPath, () => {
    ownsSocketFile = process.platform !== "win32";
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // Ignore chmod error
      }
    }
  });

  server.unref?.();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      server.close();
    } catch {
      // Ignore close error
    }
    // Only remove the socket file we created: a failed listen (for example
    // EADDRINUSE) must not delete another live session's socket.
    if (ownsSocketFile) {
      try {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
      } catch {
        // Ignore unlink error
      }
    }
    removeMarker();
  };

  return { server, cleanup };
}
