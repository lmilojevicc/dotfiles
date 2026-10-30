import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createHerdrClient,
  normalizeAgentStatus,
  parseCurrentPaneId,
  parseHerdrPaneList,
  parsePanePids,
  selectPanesForReload,
  type HerdrClient,
  type HerdrExecResult,
  type HerdrPane,
} from "../herdr.ts";
import { createBroadcastReloadExtension } from "../index.ts";
import { createSessionServer } from "../protocol.ts";

function paneListEnvelope(panes: object[]): string {
  return JSON.stringify({ id: "cli:pane:list", result: { panes }, type: "pane_list" });
}

function piPane(paneId: string, overrides: Partial<HerdrPane> = {}): HerdrPane {
  return {
    paneId,
    agent: "pi",
    agentStatus: "idle",
    cwd: "/proj",
    title: "π - proj",
    ...overrides,
  };
}

test("parseHerdrPaneList accepts envelope, bare object, and array shapes", () => {
  const raw = {
    pane_id: "w1:p1",
    agent: "pi",
    agent_status: "idle",
    cwd: "/a",
    terminal_title_stripped: "π - a",
  };
  const fromEnvelope = parseHerdrPaneList(paneListEnvelope([raw]));
  assert.equal(fromEnvelope.length, 1);
  assert.equal(fromEnvelope[0].paneId, "w1:p1");
  assert.equal(fromEnvelope[0].agentStatus, "idle");

  const fromBare = parseHerdrPaneList(JSON.stringify({ panes: [raw] }));
  assert.equal(fromBare.length, 1);

  const fromArray = parseHerdrPaneList(JSON.stringify([raw]));
  assert.equal(fromArray.length, 1);

  assert.deepEqual(parseHerdrPaneList("not json"), []);
  assert.deepEqual(parseHerdrPaneList(JSON.stringify({ result: {} })), []);
});

test("parseHerdrPaneList tolerates missing fields and normalizes status", () => {
  const panes = parseHerdrPaneList(
    paneListEnvelope([
      { pane_id: "w1:p1", agent: "pi", agent_status: "WORKING" },
      { pane_id: "w1:p2" },
      { agent: "pi" },
      "junk",
    ])
  );
  assert.equal(panes.length, 2);
  assert.equal(panes[0].agentStatus, "working");
  assert.equal(panes[0].cwd, undefined);
  assert.equal(panes[1].agent, "");
  assert.equal(panes[1].agentStatus, "unknown");
  assert.equal(normalizeAgentStatus("Idle"), "idle");
  assert.equal(normalizeAgentStatus("bogus"), "unknown");
  assert.equal(normalizeAgentStatus(undefined), "unknown");
});

test("parseCurrentPaneId and parsePanePids handle envelope shapes", () => {
  const current = JSON.stringify({
    id: "cli:pane:current",
    result: { pane: { pane_id: "w50:p1K" } },
    type: "pane_current",
  });
  assert.equal(parseCurrentPaneId(current), "w50:p1K");
  assert.equal(parseCurrentPaneId("garbage"), undefined);

  const info = JSON.stringify({
    id: "cli:pane:process_info",
    result: {
      process_info: {
        foreground_processes: [{ pid: 20802 }, { pid: "nope" }],
        shell_pid: 20693,
        pane_id: "w50:p1K",
      },
      type: "pane_process_info",
    },
  });
  assert.deepEqual(parsePanePids(info), [20802]);
  assert.deepEqual(parsePanePids("{}"), []);
});

test("selectPanesForReload enforces injection safety rules", () => {
  const panes = [
    piPane("self", { cwd: "/self" }),
    piPane("covered", { cwd: "/covered" }),
    piPane("candidate", { cwd: "/candidate" }),
    piPane("busy", { cwd: "/busy", agentStatus: "working" }),
    piPane("mystery", { cwd: "/mystery", agentStatus: "unknown" }),
    piPane("twin", { cwd: "/covered" }),
    piPane("nopid", { cwd: "/fresh" }),
    { paneId: "shell", agent: "", agentStatus: "unknown" as const },
  ];
  const selection = selectPanesForReload(panes, {
    senderPid: 9000,
    selfPaneId: "self",
    coveredPids: new Set([4242]),
    panePids: new Map([
      ["covered", [4242]],
      ["candidate", [1111]],
      ["busy", [2222]],
      ["mystery", [3333]],
      // "twin" and "nopid" have no PID entry: uncorrelated path.
    ]),
  });

  assert.deepEqual(
    selection.toReload.map((pane) => pane.paneId),
    ["candidate"]
  );
  assert.deepEqual(
    selection.alreadyCovered.map((pane) => pane.paneId),
    ["covered"]
  );
  assert.deepEqual(selection.skippedSelf.map((pane) => pane.paneId), ["self"]);
  assert.equal(selection.skippedBusy.length, 1);
  assert.equal(selection.skippedBusy[0].pane.paneId, "busy");
  // "mystery" (unknown status), "twin" (uncorrelated despite the cwd
  // matching a socket session) and "nopid" (uncorrelated, fresh cwd)
  // are all manual — never assumed covered.
  assert.deepEqual(
    selection.skippedUnknown.map((entry) => entry.pane.paneId).sort(),
    ["mystery", "nopid", "twin"]
  );
  assert.deepEqual(
    selection.notPi.map((pane) => pane.paneId),
    ["shell"]
  );
});

test("selectPanesForReload treats the sender PID as self even under another pane id", () => {
  const selection = selectPanesForReload([piPane("other-pane")], {
    senderPid: 9000,
    coveredPids: [],
    panePids: { "other-pane": [9000] },
  });
  assert.deepEqual(
    selection.skippedSelf.map((pane) => pane.paneId),
    ["other-pane"]
  );
  assert.deepEqual(selection.toReload, []);
});

test("createHerdrClient gates on env and CLI, and injects text then Enter", () => {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const exec = (args: string[], timeoutMs: number): HerdrExecResult => {
    calls.push({ args, timeoutMs });
    if (args[0] === "--version") return { ok: true, stdout: "herdr 1.2.3", stderr: "" };
    return { ok: true, stdout: "{}", stderr: "" };
  };
  const client = createHerdrClient(exec, { HERDR_ENV: "1" } as NodeJS.ProcessEnv);
  assert.equal(client.isAvailable(), true);

  const res = client.injectReload("w1:p2");
  assert.equal(res.ok, true);
  assert.deepEqual(
    calls.map((call) => call.args),
    [["--version"], ["pane", "send-text", "w1:p2", "/reload"], ["pane", "send-keys", "w1:p2", "Enter"]]
  );
});

test("createHerdrClient is unavailable without Herdr env or CLI", () => {
  const exec = (_args: string[], _timeoutMs: number): HerdrExecResult => ({
    ok: true,
    stdout: "{}",
    stderr: "",
  });
  assert.equal(createHerdrClient(exec, {} as NodeJS.ProcessEnv).isAvailable(), false);

  let versionCalls = 0;
  const failing = createHerdrClient(
    (args: string[], _timeoutMs: number): HerdrExecResult => {
      if (args[0] === "--version") {
        versionCalls += 1;
        return { ok: false, stdout: "", stderr: "nope", error: "nope" };
      }
      throw new Error("must not call herdr when unavailable");
    },
    { HERDR_ENV: "1" } as NodeJS.ProcessEnv
  );
  assert.equal(failing.isAvailable(), false);
  assert.equal(versionCalls, 1);
  assert.deepEqual(failing.listPanes(), {
    available: false,
    panes: [],
    error: "Herdr CLI is not available",
  });
});

test("createHerdrClient falls back to Return when Enter is rejected", () => {
  const exec = (args: string[], _timeoutMs: number): HerdrExecResult => {
    if (args[0] === "--version") return { ok: true, stdout: "herdr", stderr: "" };
    if (args[1] === "send-text") return { ok: true, stdout: "{}", stderr: "" };
    if (args[3] === "Enter") {
      return { ok: false, stdout: "", stderr: "unknown key: Enter", error: "unknown key: Enter" };
    }
    return { ok: true, stdout: "{}", stderr: "" };
  };
  const client = createHerdrClient(exec, { HERDR_ENV: "1" } as NodeJS.ProcessEnv);
  assert.equal(client.injectReload("w1:p9").ok, true);
});

function createMockPi() {
  const commands = new Map<string, { description: string; handler: Function }>();
  const listeners = new Map<string, Function[]>();
  const pi = {
    registerCommand(name: string, def: { description: string; handler: Function }) {
      commands.set(name, def);
    },
    on(event: string, handler: Function) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(handler);
    },
    sendUserMessage(_content: string, _options?: any) {},
  } as unknown as ExtensionAPI;

  async function emit(event: string, eventData: any, ctx: any) {
    for (const handler of listeners.get(event) || []) {
      await handler(eventData, ctx);
    }
  }

  return { pi, commands, emit };
}

function createMockCommandContext(overrides: Record<string, any> = {}): ExtensionCommandContext {
  return {
    cwd: "/self",
    isIdle: () => true,
    hasPendingMessages: () => false,
    hasUI: true,
    mode: "tui",
    ui: { notify: (_msg: string, _type?: string) => {} } as any,
    reload: async () => {},
    ...overrides,
  } as unknown as ExtensionCommandContext;
}

function stubHerdrClient(overrides: Partial<HerdrClient> = {}): HerdrClient & {
  injected: string[];
} {
  const injected: string[] = [];
  const client = {
    injected,
    isAvailable: () => true,
    listPanes: () => ({ available: true as const, panes: [] as HerdrPane[] }),
    getCurrentPaneId: () => ({ paneId: "self-pane" }),
    getPanePids: (_paneId: string) => ({ pids: [] as number[] }),
    getPaneStatus: (_paneId: string) => ({ status: "idle" as const }),
    injectReload: (paneId: string) => {
      injected.push(paneId);
      return { ok: true };
    },
    ...overrides,
  };
  return client;
}

test("/broadcast-reload injects idle plugin-less panes but never working ones", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-test-"));
  const { pi, commands, emit } = createMockPi();
  const herdr = stubHerdrClient({
    listPanes: () => ({
      available: true as const,
      panes: [
        piPane("self-pane", { cwd: "/self" }),
        piPane("w1:p2", { cwd: "/other" }),
        piPane("w1:p3", { cwd: "/busy", agentStatus: "working" }),
        { paneId: "w1:p4", agent: "", agentStatus: "unknown" },
      ],
    }),
    getPanePids: (paneId: string) => ({
      pids: paneId === "self-pane" ? [process.pid] : paneId === "w1:p2" ? [1111] : [2222],
    }),
  });
  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr, discovery: null });

  const notifications: string[] = [];
  let reloadCalled = false;
  const cmdCtx = createMockCommandContext({
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    reload: async () => {
      reloadCalled = true;
    },
  });

  await emit("session_start", { type: "session_start", reason: "startup" }, cmdCtx);
  try {
    await commands.get("broadcast-reload")!.handler("", cmdCtx);
    assert.deepEqual(herdr.injected, ["w1:p2"]);
    assert.equal(reloadCalled, true);
    const message = notifications.join("\n");
    assert.ok(message.includes("plugin-less session(s) reloaded via Herdr pane input"));
    assert.ok(message.includes("working (skipped; re-run when idle)"));
    assert.ok(message.includes("Reloading current session"));
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, cmdCtx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/broadcast-reload refuses blind injection when the sender pane is unknown", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-test-"));
  const { pi, commands, emit } = createMockPi();
  const herdr = stubHerdrClient({
    listPanes: () => ({
      available: true as const,
      panes: [piPane("w1:p2", { cwd: "/other" })],
    }),
    getCurrentPaneId: () => ({ error: "unknown" }),
    getPanePids: () => ({ pids: [1111] }),
  });
  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr, discovery: null });

  const notifications: string[] = [];
  const cmdCtx = createMockCommandContext({
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
  });

  await emit("session_start", { type: "session_start", reason: "startup" }, cmdCtx);
  try {
    await commands.get("broadcast-reload")!.handler("", cmdCtx);
    assert.deepEqual(herdr.injected, []);
    assert.ok(notifications.join("\n").includes("unknown (manual /reload)"));
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, cmdCtx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("/broadcast-reload --status reports plugin-less panes without injecting", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-test-"));
  const { pi, commands, emit } = createMockPi();
  const herdr = stubHerdrClient({
    listPanes: () => ({
      available: true as const,
      panes: [
        piPane("self-pane", { cwd: "/self" }),
        piPane("w1:p2", { cwd: "/other" }),
      ],
    }),
    getPanePids: (paneId: string) => ({
      pids: paneId === "self-pane" ? [process.pid] : [1111],
    }),
  });
  const discovery = {
    listPiProcesses: () => ({
      available: true as const,
      processes: [{ pid: 7777, command: "pi" }],
    }),
  };
  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr, discovery });

  const notifications: string[] = [];
  let reloadCalled = false;
  const cmdCtx = createMockCommandContext({
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    reload: async () => {
      reloadCalled = true;
    },
  });

  await emit("session_start", { type: "session_start", reason: "startup" }, cmdCtx);
  try {
    await commands.get("broadcast-reload")!.handler("--status", cmdCtx);
    assert.deepEqual(herdr.injected, []);
    assert.equal(reloadCalled, false);
    const message = notifications.join("\n");
    assert.ok(message.includes("Active Pi Sessions Status"));
    assert.ok(message.includes("Herdr pi panes"));
    assert.ok(message.includes("w1:p2"));
    assert.ok(message.includes("plugin: no (idle, would reload)"));
    assert.ok(message.includes("PID 7777"));
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, cmdCtx);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("injectReload attempts Escape cleanup when submit fails half-way", () => {
  const calls: string[][] = [];
  const exec = (args: string[], _timeoutMs: number): HerdrExecResult => {
    calls.push(args);
    if (args[0] === "--version") return { ok: true, stdout: "herdr", stderr: "" };
    if (args[1] === "send-text") return { ok: true, stdout: "{}", stderr: "" };
    if (args[3] === "esc") return { ok: true, stdout: "{}", stderr: "" };
    return { ok: false, stdout: "", stderr: "pty write failed", error: "pty write failed" };
  };
  const client = createHerdrClient(exec, { HERDR_ENV: "1" } as NodeJS.ProcessEnv);
  const res = client.injectReload("w1:p2");
  assert.equal(res.ok, false);
  assert.ok(res.error?.includes("pty write failed"));
  assert.ok(res.error?.includes("cleanup Escape sent"));
  assert.deepEqual(calls, [
    ["--version"],
    ["pane", "send-text", "w1:p2", "/reload"],
    ["pane", "send-keys", "w1:p2", "Enter"],
    ["pane", "send-keys", "w1:p2", "esc"],
  ]);
});

test("injectReload reports failed Escape cleanup in the error", () => {
  const exec = (args: string[], _timeoutMs: number): HerdrExecResult => {
    if (args[0] === "--version") return { ok: true, stdout: "herdr", stderr: "" };
    if (args[1] === "send-text") return { ok: true, stdout: "{}", stderr: "" };
    return { ok: false, stdout: "", stderr: "denied", error: "denied" };
  };
  const client = createHerdrClient(exec, { HERDR_ENV: "1" } as NodeJS.ProcessEnv);
  const res = client.injectReload("w1:p2");
  assert.equal(res.ok, false);
  assert.ok(res.error?.includes("cleanup Escape failed"));
});

async function runBroadcastCommand(options: {
  rawArgs: string;
  herdr?: HerdrClient | null;
  discovery?: { listPiProcesses: () => { available: boolean; processes: { pid: number; command: string }[] } } | null;
  extraSockets?: { pid: number; cwd: string }[];
}): Promise<{ notifications: string[]; injected: string[]; reloadCalled: boolean; cleanup: () => void }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-herdr-test-"));
  const cleanups: (() => void)[] = [() => fs.rmSync(tmpDir, { recursive: true, force: true })];
  const { pi, commands, emit } = createMockPi();
  const injected: string[] = [];
  const herdr =
    options.herdr !== undefined
      ? options.herdr
      : stubHerdrClient({
          injectReload: (paneId: string) => {
            injected.push(paneId);
            return { ok: true };
          },
        });
  const discovery = options.discovery !== undefined ? options.discovery : null;
  createBroadcastReloadExtension(pi, { socketDir: tmpDir, herdr, discovery: discovery as any });

  for (const extra of options.extraSockets ?? []) {
    const { cleanup } = createSessionServer(path.join(tmpDir, `${extra.pid}.sock`), () => ({
      ok: true,
      pid: extra.pid,
      status: "reloading",
      cwd: extra.cwd,
    }));
    cleanups.push(cleanup);
  }

  const notifications: string[] = [];
  let reloadCalled = false;
  const cmdCtx = createMockCommandContext({
    ui: {
      notify: (msg: string) => {
        notifications.push(msg);
      },
    },
    reload: async () => {
      reloadCalled = true;
    },
  });

  await emit("session_start", { type: "session_start", reason: "startup" }, cmdCtx);
  try {
    await commands.get("broadcast-reload")!.handler(options.rawArgs, cmdCtx);
  } finally {
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, cmdCtx);
  }
  return {
    notifications,
    injected: (herdr as unknown as { injected?: string[] } | null)?.injected ?? injected,
    reloadCalled,
    cleanup: () => {
      for (const fn of cleanups.reverse()) {
        try {
          fn();
        } catch {}
      }
    },
  };
}

test("(a) --force never injects into working or unknown Herdr panes", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "--force",
    herdr: stubHerdrClient({
      listPanes: () => ({
        available: true as const,
        panes: [
          piPane("self-pane", { cwd: "/self" }),
          piPane("w1:p2", { cwd: "/busy", agentStatus: "working" }),
          piPane("w1:p3", { cwd: "/mystery", agentStatus: "unknown" }),
        ],
      }),
      getPanePids: (paneId: string) => ({
        pids: paneId === "self-pane" ? [process.pid] : paneId === "w1:p2" ? [1111] : [2222],
      }),
    }),
  });
  try {
    assert.deepEqual(run.injected, []);
    assert.equal(run.reloadCalled, true);
    assert.ok(run.notifications.join("\n").includes("--force never injects"));
  } finally {
    run.cleanup();
  }
});

test("(b) pane that leaves idle state before injection is skipped", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "",
    herdr: stubHerdrClient({
      listPanes: () => ({
        available: true as const,
        panes: [
          piPane("self-pane", { cwd: "/self" }),
          piPane("w1:p2", { cwd: "/other" }),
        ],
      }),
      getPanePids: (paneId: string) => ({
        pids: paneId === "self-pane" ? [process.pid] : [1111],
      }),
      // Idle at scan time, streaming by inject time.
      getPaneStatus: (paneId: string) =>
        paneId === "w1:p2" ? { status: "working" as const } : { status: "idle" as const },
    }),
  });
  try {
    // Without the pre-injection re-check this pane would have been injected:
    // it was idle and PID-correlated at scan time.
    assert.deepEqual(run.injected, []);
    assert.ok(run.notifications.join("\n").includes("unknown (manual /reload)"));
  } finally {
    run.cleanup();
  }
});

test("(c) process-info failure end-to-end routes the pane to manual", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "",
    herdr: stubHerdrClient({
      listPanes: () => ({
        available: true as const,
        panes: [
          piPane("self-pane", { cwd: "/self" }),
          piPane("w1:p2", { cwd: "/other" }),
        ],
      }),
      getPanePids: (paneId: string) =>
        paneId === "self-pane" ? { pids: [process.pid] } : { pids: [], error: "denied" },
    }),
  });
  try {
    assert.deepEqual(run.injected, []);
    assert.ok(run.notifications.join("\n").includes("unknown (manual /reload)"));
  } finally {
    run.cleanup();
  }
});

test("(d) twin sessions in one repo: plugin-less twin stays manual", async () => {
  const sleeper = spawn("sleep", ["30"]);
  assert.ok(sleeper.pid);
  const decoyPid = sleeper.pid as number;
  try {
    const run = await runBroadcastCommand({
      rawArgs: "",
      extraSockets: [{ pid: decoyPid, cwd: "/twin" }],
      herdr: stubHerdrClient({
        listPanes: () => ({
          available: true as const,
          panes: [
            piPane("self-pane", { cwd: "/self" }),
            // Plugin-less twin: same cwd as the socket session, PID unknown.
            piPane("w1:p2", { cwd: "/twin" }),
          ],
        }),
        getPanePids: (paneId: string) => ({
          pids: paneId === "self-pane" ? [process.pid] : [],
        }),
      }),
    });
    try {
      assert.deepEqual(run.injected, []);
      const message = run.notifications.join("\n");
      assert.ok(message.includes("unknown (manual /reload)"));
      assert.ok(!message.includes("assumed covered"));
      assert.ok(!message.includes("likely (same cwd)"));
    } finally {
      run.cleanup();
    }
  } finally {
    sleeper.kill();
  }
});

test("(e) failing pane list degrades to socket broadcast", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "--status",
    herdr: stubHerdrClient({
      listPanes: () => ({ available: true as const, panes: [], error: "boom" }),
    }),
  });
  try {
    assert.deepEqual(run.injected, []);
    assert.equal(run.reloadCalled, false);
    const message = run.notifications.join("\n");
    assert.ok(message.includes("Active Pi Sessions Status"));
    assert.ok(message.includes("unavailable (boom)"));
  } finally {
    run.cleanup();
  }
});

test("(P2-5) empty pane list reports none detected, not unavailable", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "--status",
    herdr: stubHerdrClient({
      listPanes: () => ({ available: true as const, panes: [] }),
    }),
  });
  try {
    const message = run.notifications.join("\n");
    assert.ok(message.includes("none detected"));
    assert.ok(!message.includes("unavailable"));
  } finally {
    run.cleanup();
  }
});

test("(f) discovery sweep on the reload path reports strays for manual reload", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "",
    discovery: {
      listPiProcesses: () => ({
        available: true as const,
        processes: [{ pid: 7777, command: "pi" }],
      }),
    },
  });
  try {
    assert.equal(run.reloadCalled, true);
    assert.ok(run.notifications.join("\n").includes("manual /reload needed: PID 7777"));
  } finally {
    run.cleanup();
  }
});

test("sweep hit overlapping an uncorrelated pane is labeled ambiguous, not duplicated", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "--status",
    herdr: stubHerdrClient({
      listPanes: () => ({
        available: true as const,
        panes: [
          piPane("self-pane", { cwd: "/self" }),
          piPane("w1:p2", { cwd: "/other" }),
        ],
      }),
      // Candidate PID cannot be correlated: already listed as manual above.
      getPanePids: (paneId: string) => ({
        pids: paneId === "self-pane" ? [process.pid] : [],
      }),
    }),
    discovery: {
      listPiProcesses: () => ({
        available: true as const,
        processes: [{ pid: 7777, command: "pi" }],
      }),
    },
  });
  try {
    const message = run.notifications.join("\n");
    assert.ok(message.includes("PID 7777"));
    assert.ok(message.includes("may be Herdr pane w1:p2 listed above"));
  } finally {
    run.cleanup();
  }
});

test("degraded Herdr/process scans are reported instead of a clean picture", async () => {
  const herdr = stubHerdrClient({
    listPanes: () => ({ available: true as const, panes: [], error: "pane list failed" }),
  });
  const run = await runBroadcastCommand({
    rawArgs: "",
    herdr,
    discovery: {
      listPiProcesses: () => ({
        available: false as const,
        processes: [],
        error: "ps is not available",
      }),
    },
  });
  try {
    const message = run.notifications.join("\n");
    // Reload summary: both silent degradations must be visible.
    assert.ok(message.includes("Herdr fallback unavailable (pane list failed)"));
    assert.ok(message.includes("process sweep unavailable (ps is not available)"));
  } finally {
    run.cleanup();
  }
});

test("--status reports a failed process sweep", async () => {
  const run = await runBroadcastCommand({
    rawArgs: "--status",
    herdr: stubHerdrClient({
      listPanes: () => ({ available: true as const, panes: [] }),
    }),
    discovery: {
      listPiProcesses: () => ({
        available: false as const,
        processes: [],
        error: "ps is not available",
      }),
    },
  });
  try {
    const message = run.notifications.join("\n");
    assert.ok(message.includes("Process sweep: unavailable (ps is not available)"));
  } finally {
    run.cleanup();
  }
});
