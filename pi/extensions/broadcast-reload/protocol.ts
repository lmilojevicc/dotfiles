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

export function getSocketPath(pid: number, socketDir: string = getDefaultSocketDir()): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-broadcast-reload-${pid}`;
  }
  return path.join(socketDir, `${pid}.sock`);
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

export function createSessionServer(
  socketPath: string,
  onRequest: (msg: RequestMessage) => Promise<SessionResponse> | SessionResponse
): { server: net.Server; cleanup: () => void } {
  // Ensure socket directory exists
  if (process.platform !== "win32") {
    const dir = path.dirname(socketPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // Clean up dead socket if file exists
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Ignore unlink error
      }
    }
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

  server.listen(socketPath, () => {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(socketPath, 0o600);
      } catch {
        // Ignore chmod error
      }
    }
  });

  server.unref?.();

  const cleanup = () => {
    try {
      server.close();
    } catch {
      // Ignore close error
    }
    if (process.platform !== "win32") {
      try {
        if (fs.existsSync(socketPath)) {
          fs.unlinkSync(socketPath);
        }
      } catch {
        // Ignore unlink error
      }
    }
  };

  return { server, cleanup };
}
