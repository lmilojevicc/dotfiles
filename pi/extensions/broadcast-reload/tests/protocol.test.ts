import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSessionServer,
  getSocketPath,
  isProcessAlive,
  parsePidFromSocketPath,
  sendSocketMessage,
  type RequestMessage,
  type SessionResponse,
} from "../protocol.ts";

test("getSocketPath and parsePidFromSocketPath", () => {
  const tmpDir = path.join(os.tmpdir(), "pi-test-sockets");
  const pid = 12345;
  const socketPath = getSocketPath(pid, tmpDir);

  if (process.platform === "win32") {
    assert.match(socketPath, /\\\\.\\pipe\\pi-broadcast-reload-12345/);
  } else {
    assert.equal(socketPath, path.join(tmpDir, "12345.sock"));
    assert.equal(parsePidFromSocketPath(socketPath), 12345);
    assert.equal(parsePidFromSocketPath("/some/path/invalid.sock"), null);
    assert.equal(parsePidFromSocketPath("/some/path/abc.sock"), null);
  }
});

test("isProcessAlive identifies alive and dead processes", () => {
  assert.equal(isProcessAlive(process.pid), true);
  // Extremely high PID unlikely to exist
  assert.equal(isProcessAlive(99999999), false);
});

test("createSessionServer and sendSocketMessage exchange messages", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-br-test-"));
  const socketPath = path.join(tmpDir, `${process.pid}.sock`);

  const { server, cleanup } = createSessionServer(socketPath, (msg: RequestMessage): SessionResponse => {
    if (msg.type === "ping") {
      return { ok: true, pid: process.pid, status: "idle" };
    }
    if (msg.type === "reload") {
      return { ok: true, pid: process.pid, status: "reloading" };
    }
    return { ok: false, pid: process.pid, status: "error", reason: "Unknown" };
  });

  try {
    const pingRes = await sendSocketMessage(socketPath, { type: "ping" });
    assert.equal(pingRes.ok, true);
    assert.equal(pingRes.status, "idle");
    assert.equal(pingRes.pid, process.pid);

    const reloadRes = await sendSocketMessage(socketPath, { type: "reload", senderPid: 999 });
    assert.equal(reloadRes.ok, true);
    assert.equal(reloadRes.status, "reloading");
  } finally {
    cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sendSocketMessage times out when no response is sent", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-br-test-"));
  const socketPath = path.join(tmpDir, `${process.pid}.sock`);

  // Server that deliberately never responds
  const net = await import("node:net");
  const server = net.createServer((_socket) => {
    // Hang connection
  });
  server.listen(socketPath);

  try {
    await assert.rejects(
      async () => {
        await sendSocketMessage(socketPath, { type: "ping" }, 150);
      },
      (err: any) => {
        return err.code === "ETIMEDOUT" || err.message.includes("timed out");
      }
    );
  } finally {
    server.close();
    try {
      fs.unlinkSync(socketPath);
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
