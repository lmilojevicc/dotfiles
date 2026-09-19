import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModule } from "./runtime.ts";

interface ForkToPaneDependencies {
  herdr: any;
  bootstrapPath: string;
  chooseCandidate: Function;
  createFork: Function;
  createProtectedHandoff: Function;
}

const { parsePlacement, runForkToPane } = await loadModule<{
  parsePlacement(args: string): "horizontal" | "vertical" | "tab" | "invalid" | undefined;
  runForkToPane(args: string, ctx: any, dependencies: ForkToPaneDependencies): Promise<void>;
}>("../index.ts");

function context(file: string, overrides: Record<string, any> = {}) {
  const notifications: Array<[string, string | undefined]> = [];
  let sourceForkCalls = 0;
  const ctx = {
    cwd: "/project",
    mode: "tui",
    hasUI: true,
    model: { provider: "runtime-provider", id: "runtime-model" },
    thinkingLevel: "high",
    isIdle: () => true,
    hasPendingMessages: () => false,
    fork: async () => { sourceForkCalls += 1; return { cancelled: false }; },
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => "source",
      getSessionDir: () => join(file, ".."),
      getEntry: (id: string) => id === "u1" ? {
        type: "message", id: "u1", parentId: null, timestamp: "now",
        message: { role: "user", content: "prompt", timestamp: 1 },
      } : undefined,
      getEntries: () => [{
        type: "message", id: "u1", parentId: null, timestamp: "now",
        message: { role: "user", content: "prompt", timestamp: 1 },
      }],
    },
    ui: {
      notify: (message: string, type?: string) => notifications.push([message, type]),
      select: async () => "Right",
    },
    ...overrides,
  } as any;
  return { ctx, notifications, getSourceForkCalls: () => sourceForkCalls };
}

function dependencies(overrides: Partial<ForkToPaneDependencies> = {}) {
  const launches: any[] = [];
  const deps: ForkToPaneDependencies = {
    herdr: {
      validateSource: () => ({ ok: true, sourcePaneId: "source-pane" }),
      launch: (request) => { launches.push(request); return { ok: true, paneId: "new-pane" }; },
    },
    bootstrapPath: "/extension/bootstrap.ts",
    chooseCandidate: async (_ctx, candidates) => candidates.at(-1) ?? null,
    createFork: (snapshot) => ({
      path: "/sessions/fork.jsonl",
      sessionId: "fork",
      editorText: snapshot.text,
      launchState: snapshot.runtimeState,
    }),
    createProtectedHandoff: () => ({ path: "/tmp/handoff.json", nonce: "nonce" }),
    ...overrides,
  };
  return { deps, launches };
}

test("argument parsing accepts only the documented orientations", () => {
  assert.equal(parsePlacement(""), undefined);
  assert.equal(parsePlacement(" horizontal "), "horizontal");
  assert.equal(parsePlacement("VERTICAL"), "vertical");
  assert.equal(parsePlacement("tab"), "tab");
  assert.equal(parsePlacement("right"), "invalid");
  assert.equal(parsePlacement("horizontal extra"), "invalid");
});

test("invalid args and non-TUI calls stop before host or session side effects", async () => {
  const { deps } = dependencies({
    herdr: {
      validateSource: () => { throw new Error("must not validate"); },
      launch: () => { throw new Error("must not launch"); },
    },
  });
  const invalid = context("/missing");
  await runForkToPane("diagonal", invalid.ctx, deps);
  assert.match(invalid.notifications[0][0], /Usage/);

  const noUi = context("/missing", { mode: "print", hasUI: false });
  await runForkToPane("horizontal", noUi.ctx, deps);
  assert.match(noUi.notifications[0][0], /interactive TUI/);
});

test("unsupported host and picker cancellation create no fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-command-"));
  const file = join(dir, "source.jsonl");
  writeFileSync(file, "{}\n");
  try {
    let forkCalls = 0;
    const unsupported = dependencies({
      herdr: { validateSource: () => ({ ok: false, error: "Herdr required" }), launch: () => ({ ok: false }) },
      createFork: () => { forkCalls += 1; throw new Error("unexpected"); },
    });
    const first = context(file);
    await runForkToPane("horizontal", first.ctx, unsupported.deps);
    assert.equal(forkCalls, 0);
    assert.match(first.notifications[0][0], /Herdr required/);

    const cancelled = dependencies({
      chooseCandidate: async () => null,
      createFork: () => { forkCalls += 1; throw new Error("unexpected"); },
    });
    const second = context(file);
    await runForkToPane("horizontal", second.ctx, cancelled.deps);
    assert.equal(forkCalls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("successful command launches a separate Pi fork and never calls ctx.fork", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-command-"));
  const file = join(dir, "source.jsonl");
  writeFileSync(file, "{}\n");
  try {
    const { deps, launches } = dependencies();
    const run = context(file);
    await runForkToPane("vertical", run.ctx, deps);
    assert.equal(run.getSourceForkCalls(), 0);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].placement, "vertical");
    assert.equal(launches[0].cwd, "/project");
    assert.equal(launches[0].sessionPath, "/sessions/fork.jsonl");
    assert.equal(launches[0].sessionId, "fork");
    assert.deepEqual(launches[0].runtimeState, {
      model: { provider: "runtime-provider", modelId: "runtime-model" },
      thinkingLevel: "high",
    });
    assert.ok(run.notifications.at(-1)?.[0].includes("source session unchanged"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("command does not report success before child readiness acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-command-"));
  const file = join(dir, "source.jsonl");
  writeFileSync(file, "{}\n");
  try {
    let acknowledge: ((result: any) => void) | undefined;
    const launchResult = new Promise((resolve) => { acknowledge = resolve; });
    const { deps } = dependencies({
      herdr: {
        validateSource: () => ({ ok: true, sourcePaneId: "source-pane" }),
        launch: () => launchResult,
      },
    });
    const run = context(file);
    const pending = runForkToPane("horizontal", run.ctx, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(run.notifications.length, 0);

    acknowledge!({ ok: true, paneId: "new-pane" });
    await pending;
    assert.match(run.notifications.at(-1)?.[0] ?? "", /Fork opened/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readiness failure removes the protected handoff and never reports success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-command-"));
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-fork-to-pane-command-"));
  chmodSync(handoffDir, 0o700);
  const file = join(dir, "source.jsonl");
  const handoffPath = join(handoffDir, "handoff.json");
  writeFileSync(file, "{}\n");
  writeFileSync(handoffPath, "protected prompt", { mode: 0o600 });
  try {
    const { deps } = dependencies({
      herdr: {
        validateSource: () => ({ ok: true, sourcePaneId: "source-pane" }),
        launch: async () => ({ ok: false, paneId: "new-pane", error: "readiness timed out" }),
      },
      createProtectedHandoff: () => ({ path: handoffPath, nonce: "nonce" }),
    });
    const run = context(file);
    await runForkToPane("horizontal", run.ctx, deps);
    assert.equal(existsSync(handoffDir), false);
    assert.equal(run.notifications.some(([message]) => message.includes("Fork opened")), false);
    assert.match(run.notifications.at(-1)?.[0] ?? "", /readiness timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(handoffDir, { recursive: true, force: true });
  }
});

test("no args offers exactly Right, Below, and New tab; explicit tab bypasses it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-command-"));
  const file = join(dir, "source.jsonl");
  writeFileSync(file, "{}\n");
  try {
    const first = context(file);
    let offered: string[] | undefined;
    (first.ctx as any).ui.select = async (_title: string, options: string[]) => {
      offered = options;
      return "New tab";
    };
    const chooserRun = dependencies();
    await runForkToPane("", first.ctx, chooserRun.deps);
    assert.deepEqual(offered, ["Right", "Below", "New tab"]);
    assert.equal(chooserRun.launches[0].placement, "tab");

    const second = context(file);
    (second.ctx as any).ui.select = async () => { throw new Error("chooser must be bypassed"); };
    const directRun = dependencies();
    await runForkToPane("tab", second.ctx, directRun.deps);
    assert.equal(directRun.launches[0].placement, "tab");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("busy sessions are rejected before opening a chooser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-command-"));
  const file = join(dir, "source.jsonl");
  writeFileSync(file, "{}\n");
  try {
    let picked = false;
    const { deps } = dependencies({ chooseCandidate: async () => { picked = true; return null; } });
    const run = context(file, { isIdle: () => false });
    await runForkToPane("horizontal", run.ctx, deps);
    assert.equal(picked, false);
    assert.match(run.notifications[0][0], /idle/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
