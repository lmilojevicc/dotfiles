import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createSessionServer,
  getSocketMarkerPath,
  getSocketPath,
  isProcessAlive,
  parsePidFromSocketPath,
  resolveSocketAddress,
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

test("a failed listen is reported once instead of crashing the process", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-br-test-"));
  // A basename longer than the sun_path limit makes listen() fail on every
  // platform (EINVAL/ENAMETOOLONG), so IPC has to degrade, not throw.
  const socketPath = path.join(tmpDir, `${"x".repeat(200)}.sock`);
  const markerPath = path.join(tmpDir, "failed-listen.sock");

  let resolveError: (error: Error) => void = () => {};
  const errorReported = new Promise<Error>((resolve) => {
    resolveError = resolve;
  });
  const errors: Error[] = [];

  const { server, cleanup } = createSessionServer(
    socketPath,
    (): SessionResponse => ({ ok: true, pid: process.pid, status: "idle" }),
    {
      markerPath,
      onError: (error) => {
        errors.push(error);
        resolveError(error);
      },
    }
  );

  try {
    const error = await errorReported;
    assert.ok(error.message.length > 0);
    assert.equal(server.listening, false);
    assert.equal(errors.length, 1);
    // No marker may advertise a listener that never came up.
    assert.equal(fs.existsSync(markerPath), false);
  } finally {
    cleanup();
    cleanup(); // idempotent
    assert.equal(fs.existsSync(socketPath), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Windows sessions publish a socket-dir marker that maps to the named pipe", () => {
  const dir = path.join(os.tmpdir(), "pi-marker-test");
  // A named pipe is not a directory entry, so discovery needs the marker.
  assert.equal(getSocketPath(4321, dir, "win32"), "\\\\.\\pipe\\pi-broadcast-reload-4321");
  assert.equal(getSocketMarkerPath(4321, dir), path.join(dir, "4321.sock"));
  assert.equal(resolveSocketAddress(path.join(dir, "4321.sock"), "win32"), "\\\\.\\pipe\\pi-broadcast-reload-4321");

  // POSIX: the socket file itself is the marker, so nothing is rewritten.
  assert.equal(getSocketPath(4321, dir, "linux"), path.join(dir, "4321.sock"));
  assert.equal(resolveSocketAddress(path.join(dir, "4321.sock"), "linux"), path.join(dir, "4321.sock"));

  // An unparseable marker is not turned into a pipe name.
  assert.equal(resolveSocketAddress(path.join(dir, "not-a-pid.sock"), "win32"), path.join(dir, "not-a-pid.sock"));
});

test("a published marker is created, served, and removed on cleanup", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-br-test-"));
  const socketPath = path.join(tmpDir, `${process.pid}.sock`);
  const markerPath = path.join(tmpDir, "marker.sock");

  const { cleanup } = createSessionServer(
    socketPath,
    (msg: RequestMessage): SessionResponse => ({ ok: true, pid: process.pid, status: "idle", reason: msg.type }),
    { markerPath }
  );

  try {
    // The marker names the PID that owns the socket, like the POSIX socket file.
    assert.equal(fs.readFileSync(markerPath, "utf8").trim(), String(process.pid));
    const res = await sendSocketMessage(socketPath, { type: "ping" });
    assert.equal(res.status, "idle");
  } finally {
    cleanup();
    assert.equal(fs.existsSync(markerPath), false);
    assert.equal(fs.existsSync(socketPath), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
