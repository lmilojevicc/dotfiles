import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createBroadcastReloadExtension } from "../index.ts";
import { getSocketPath, sendSocketMessage } from "../protocol.ts";

function createMockPi() {
  const commands = new Map<string, { description: string; handler: Function }>();
  const listeners = new Map<string, Function[]>();
  const sentUserMessages: { content: string; options?: any }[] = [];

  const pi = {
    registerCommand(name: string, def: { description: string; handler: Function }) {
      commands.set(name, def);
    },
    on(event: string, handler: Function) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    },
    sendUserMessage(content: string, options?: any) {
      sentUserMessages.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  async function emit(event: string, eventData: any, ctx: any) {
    const list = listeners.get(event) || [];
    for (const handler of list) {
      await handler(eventData, ctx);
    }
  }

  return { pi, commands, listeners, sentUserMessages, emit };
}

function createMockContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: "/mock/cwd",
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasUI: true,
    mode: "tui",
    sessionManager: {
      getSessionId: () => "sess-123",
      getSessionFile: () => "/mock/session.json",
    } as any,
    ui: {
      notify: (_msg: string, _type?: string) => {},
    } as any,
    ...overrides,
  } as unknown as ExtensionContext;
}

test("idle session reloads immediately upon receiving reload request", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-life-test-"));
  const { pi, commands, sentUserMessages, emit } = createMockPi();

  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr: null, discovery: null });

  const ctx = createMockContext({ isIdle: () => true });
  await emit("session_start", { type: "session_start", reason: "startup" }, ctx);

  const socketPath = getSocketPath(process.pid, tmpDir);

  try {
    const res = await sendSocketMessage(socketPath, { type: "reload", senderPid: 9999 });
    assert.equal(res.ok, true);
    assert.equal(res.status, "reloading");

    // Wait for setImmediate
    await new Promise((resolve) => setImmediate(resolve));

    // Internal reload command should have been queued
    assert.equal(sentUserMessages.length, 1);
    assert.equal(sentUserMessages[0].content, "/_broadcast_reload_apply");
    assert.equal(sentUserMessages[0].options?.expandPromptTemplates, true);
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("busy session defers reload until agent_settled", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-life-test-"));
  const { pi, sentUserMessages, emit } = createMockPi();

  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr: null, discovery: null });

  let idleState = false; // Agent is currently busy
  const notifications: string[] = [];
  const ctx = createMockContext({
    isIdle: () => idleState,
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    } as any,
  });

  await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await emit("agent_start", {}, ctx);

  const socketPath = getSocketPath(process.pid, tmpDir);

  try {
    // Send reload while busy
    const res = await sendSocketMessage(socketPath, { type: "reload", senderPid: 9999, force: false });
    assert.equal(res.ok, true);
    assert.equal(res.status, "queued_busy");

    // No reload triggered yet
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentUserMessages.length, 0);
    assert.ok(notifications.some((n) => n.includes("queued")));

    // Now agent finishes and settles
    idleState = true;
    await emit("agent_settled", {}, ctx);

    // Should now trigger the deferred reload!
    assert.equal(sentUserMessages.length, 1);
    assert.equal(sentUserMessages[0].content, "/_broadcast_reload_apply");
    assert.ok(notifications.some((n) => n.includes("Applying queued broadcast reload")));
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("busy session reloads immediately if force: true is sent", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-life-test-"));
  const { pi, sentUserMessages, emit } = createMockPi();

  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr: null, discovery: null });

  const ctx = createMockContext({ isIdle: () => false });
  await emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await emit("agent_start", {}, ctx);

  const socketPath = getSocketPath(process.pid, tmpDir);

  try {
    // Send reload with force: true
    const res = await sendSocketMessage(socketPath, { type: "reload", senderPid: 9999, force: true });
    assert.equal(res.ok, true);
    assert.equal(res.status, "reloading");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sentUserMessages.length, 1);
    assert.equal(sentUserMessages[0].content, "/_broadcast_reload_apply");
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/broadcast-reload --status queries without reloading", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-life-test-"));
  const { pi, commands, sentUserMessages, emit } = createMockPi();

  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr: null, discovery: null });

  const notifications: string[] = [];
  let reloadCalled = false;

  const cmdCtx = {
    ...createMockContext(),
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    reload: async () => {
      reloadCalled = true;
    },
  } as unknown as ExtensionCommandContext;

  await emit("session_start", { type: "session_start", reason: "startup" }, cmdCtx);

  try {
    const cmd = commands.get("broadcast-reload");
    assert.ok(cmd);

    await cmd.handler("--status", cmdCtx);

    // Should NOT have triggered any reload
    assert.equal(reloadCalled, false);
    assert.equal(sentUserMessages.length, 0);
    assert.ok(notifications.some((n) => n.includes("Active Pi Sessions Status")));
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, cmdCtx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/broadcast-reload --help displays help", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-life-test-"));
  const { pi, commands, emit } = createMockPi();

  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr: null, discovery: null });

  const notifications: string[] = [];
  let reloadCalled = false;

  const cmdCtx = {
    ...createMockContext(),
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    reload: async () => {
      reloadCalled = true;
    },
  } as unknown as ExtensionCommandContext;

  await emit("session_start", { type: "session_start", reason: "startup" }, cmdCtx);

  try {
    const cmd = commands.get("broadcast-reload");
    assert.ok(cmd);

    await cmd.handler("--help", cmdCtx);

    assert.equal(reloadCalled, false);
    assert.ok(notifications.some((n) => n.includes("Usage:")));
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, cmdCtx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/broadcast-reload command reloads current session", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-life-test-"));
  const { pi, commands, emit } = createMockPi();

  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr: null, discovery: null });

  let reloadCalled = false;
  const notifications: string[] = [];

  const cmdCtx = {
    ...createMockContext(),
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    reload: async () => {
      reloadCalled = true;
    },
  } as unknown as ExtensionCommandContext;

  await emit("session_start", { type: "session_start", reason: "startup" }, cmdCtx);

  try {
    const cmd = commands.get("broadcast-reload");
    assert.ok(cmd);

    await cmd.handler("", cmdCtx);

    // Current session reload must be called
    assert.equal(reloadCalled, true);
    assert.ok(notifications.some((n) => n.includes("Reloading current session")));
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, cmdCtx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
