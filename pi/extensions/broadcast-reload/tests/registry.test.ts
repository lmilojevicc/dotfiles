import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSessionServer, type RequestMessage, type SessionResponse } from "../protocol.ts";
import { broadcastToSessions, cleanStaleSocketFile, listActiveSocketPaths } from "../registry.ts";

test("listActiveSocketPaths and cleanStaleSocketFile", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reg-test-"));
  try {
    const file1 = path.join(tmpDir, "100.sock");
    const file2 = path.join(tmpDir, "200.sock");
    const other = path.join(tmpDir, "not-a-socket.txt");

    fs.writeFileSync(file1, "");
    fs.writeFileSync(file2, "");
    fs.writeFileSync(other, "");

    const list = listActiveSocketPaths(tmpDir);
    assert.equal(list.length, 2);
    assert.ok(list.includes(file1));
    assert.ok(list.includes(file2));

    assert.equal(cleanStaleSocketFile(file1), true);
    assert.equal(fs.existsSync(file1), false);
    assert.equal(cleanStaleSocketFile(file1), false); // already removed
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("broadcastToSessions contacts multiple sessions and handles stale sockets", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-reg-test-"));

  // Create 2 active servers:
  // Server 1 (idle -> reloading)
  const sock1 = path.join(tmpDir, "1001.sock");
  const s1 = createSessionServer(sock1, (_msg: RequestMessage): SessionResponse => {
    return { ok: true, pid: 1001, status: "reloading", cwd: "/proj1" };
  });

  // Server 2 (busy -> queued_busy)
  const sock2 = path.join(tmpDir, "1002.sock");
  const s2 = createSessionServer(sock2, (msg: RequestMessage): SessionResponse => {
    if (msg.type === "reload" && !msg.force) {
      return { ok: true, pid: 1002, status: "queued_busy", cwd: "/proj2", reason: "Running task" };
    }
    return { ok: true, pid: 1002, status: "reloading", cwd: "/proj2" };
  });

  // Create 1 stale socket file (dead PID)
  const staleSock = path.join(tmpDir, "99999998.sock");
  fs.writeFileSync(staleSock, "");

  try {
    const summary = await broadcastToSessions({
      senderPid: 9999,
      request: { type: "reload", senderPid: 9999 },
      socketDir: tmpDir,
      checkProcessAlive: (pid) => pid === 1001 || pid === 1002,
    });

    assert.equal(summary.reloaded.length, 1);
    assert.equal(summary.reloaded[0].pid, 1001);

    assert.equal(summary.queuedBusy.length, 1);
    assert.equal(summary.queuedBusy[0].pid, 1002);

    // Stale socket should have been cleaned up
    assert.equal(summary.cleanedStaleSockets.length, 1);
    assert.equal(fs.existsSync(staleSock), false);
  } finally {
    s1.cleanup();
    s2.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
