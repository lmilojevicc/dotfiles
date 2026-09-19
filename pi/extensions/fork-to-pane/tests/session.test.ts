import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadModule, loadPi } from "./runtime.ts";

const { SessionManager } = await loadPi<any>();
const {
  HANDOFF_NONCE_ENV,
  HANDOFF_PATH_ENV,
  captureForkSnapshot,
  cleanupHandoff,
  createForkFromSnapshot,
  createHandoff,
  getForkCandidates,
  getHandoffReadyPath,
  publishHandoffReady,
  restoreEditorFromHandoff,
  waitForHandoffReady,
} = await loadModule<any>("../session.ts");

function message(id: string, parentId: string | null, role: "user" | "assistant", content: unknown) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: role === "user"
      ? { role, content, timestamp: Date.now() }
      : {
          role,
          content: [{ type: "text", text: String(content) }],
          api: "test",
          provider: "test",
          model: "test",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
  };
}

function modelChange(id: string, parentId: string | null, provider: string, modelId: string) {
  return { type: "model_change", id, parentId, timestamp: new Date().toISOString(), provider, modelId };
}

function thinkingChange(id: string, parentId: string | null, thinkingLevel: string) {
  return { type: "thinking_level_change", id, parentId, timestamp: new Date().toISOString(), thinkingLevel };
}

function writeSession(dir: string, entries: object[], id = "source-session"): string {
  const file = join(dir, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir };
  writeFileSync(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  return file;
}

test("candidate extraction matches native all-entry user-message behavior", () => {
  const entries = [
    message("u1", null, "user", "first"),
    message("a1", "u1", "assistant", "answer"),
    message("u2", "a1", "user", [{ type: "text", text: "second" }, { type: "image", data: "x" }]),
    message("blank", "u2", "user", ""),
  ];
  assert.deepEqual(getForkCandidates(entries as any), [
    { entryId: "u1", text: "first" },
    { entryId: "u2", text: "second" },
  ]);
});

test("fork creation copies the path before the selected prompt without mutating source", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-session-"));
  try {
    const file = writeSession(dir, [
      message("u1", null, "user", "first"),
      message("a1", "u1", "assistant", "answer"),
      modelChange("m1", "a1", "historical-provider", "historical-model"),
      thinkingChange("t1", "m1", "high"),
      message("u2", "t1", "user", "edit me"),
    ]);
    const source = SessionManager.open(file, dir);
    const before = readFileSync(file, "utf8");
    const snapshot = captureForkSnapshot(source, { entryId: "u2", text: "edit me" });
    const fork = createForkFromSnapshot(snapshot);
    const opened = SessionManager.open(fork.path, dir);

    assert.equal(fork.editorText, "edit me");
    assert.deepEqual(opened.getEntries().map((entry) => entry.id), ["u1", "a1", "m1", "t1"]);
    assert.deepEqual(opened.buildSessionContext().model, {
      provider: "historical-provider",
      modelId: "historical-model",
    });
    assert.equal(opened.buildSessionContext().thinkingLevel, "high");
    assert.equal(fork.launchState, undefined);
    assert.equal(opened.getHeader()?.parentSession, file);
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("root-message fork writes an exclusive v3 header-only session with mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-root-"));
  try {
    const file = writeSession(dir, [message("u1", null, "user", "root prompt")]);
    const source = SessionManager.open(file, dir);
    const snapshot = captureForkSnapshot(source, { entryId: "u1", text: "root prompt" });
    const fork = createForkFromSnapshot(snapshot);
    const lines = readFileSync(fork.path, "utf8").trim().split("\n");
    const header = JSON.parse(lines[0]);

    assert.equal(lines.length, 1);
    assert.equal(header.type, "session");
    assert.equal(header.version, 3);
    assert.equal(header.cwd, dir);
    assert.equal(header.parentSession, file);
    assert.equal(header.id, fork.sessionId);
    assert.equal(statSync(fork.path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-prompt fork materializes retained model metadata and uses its effective model", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-first-model-"));
  try {
    const file = writeSession(dir, [
      modelChange("m1", null, "historical-provider", "historical-model"),
      message("u1", "m1", "user", "first prompt"),
    ]);
    const before = readFileSync(file, "utf8");
    const source = SessionManager.open(file, dir);
    const snapshot = captureForkSnapshot(source, { entryId: "u1", text: "first prompt" }, {
      model: { provider: "current-provider", modelId: "current-model" },
      thinkingLevel: "high",
    });
    const fork = createForkFromSnapshot(snapshot);
    const opened = SessionManager.open(fork.path, dir);

    assert.deepEqual(opened.getEntries().map(({ type, id, parentId, ...entry }) => ({
      type,
      id,
      parentId,
      provider: "provider" in entry ? entry.provider : undefined,
      modelId: "modelId" in entry ? entry.modelId : undefined,
    })), [{
      type: "model_change",
      id: "m1",
      parentId: null,
      provider: "historical-provider",
      modelId: "historical-model",
    }]);
    assert.deepEqual(fork.launchState, {
      model: { provider: "historical-provider", modelId: "historical-model" },
      thinkingLevel: "high",
    });
    assert.equal(readFileSync(file, "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("first-prompt fork materializes retained thinking metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-first-thinking-"));
  try {
    const file = writeSession(dir, [
      thinkingChange("t1", null, "xhigh"),
      message("u1", "t1", "user", "first prompt"),
    ]);
    const source = SessionManager.open(file, dir);
    const snapshot = captureForkSnapshot(source, { entryId: "u1", text: "first prompt" }, {
      model: { provider: "runtime-provider", modelId: "runtime-model" },
      thinkingLevel: "low",
    });
    const fork = createForkFromSnapshot(snapshot);
    const opened = SessionManager.open(fork.path, dir);

    assert.equal(opened.getEntries().length, 1);
    assert.equal(opened.getEntries()[0]?.type, "thinking_level_change");
    assert.equal((opened.getEntries()[0] as any).thinkingLevel, "xhigh");
    assert.equal(opened.getEntries()[0]?.parentId, null);
    assert.deepEqual(fork.launchState, {
      model: { provider: "runtime-provider", modelId: "runtime-model" },
      thinkingLevel: "xhigh",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state-empty root fork carries the active runtime model and thinking level", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-root-runtime-"));
  try {
    const file = writeSession(dir, [message("u1", null, "user", "root prompt")]);
    const source = SessionManager.open(file, dir);
    const runtimeState = {
      model: { provider: "nondefault-provider", modelId: "nondefault-model" },
      thinkingLevel: "max" as const,
    };
    const snapshot = captureForkSnapshot(source, { entryId: "u1", text: "root prompt" }, runtimeState);
    const fork = createForkFromSnapshot(snapshot);

    assert.deepEqual(fork.launchState, runtimeState);
    assert.equal(SessionManager.open(fork.path, dir).getEntries().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fork creation rejects a stale selected message", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-stale-"));
  try {
    const file = writeSession(dir, [message("u1", null, "user", "original")]);
    const source = SessionManager.open(file, dir);
    const snapshot = captureForkSnapshot(source, { entryId: "u1", text: "original" });
    writeSession(dir, [message("u1", null, "user", "changed")]);
    assert.throws(() => createForkFromSnapshot(snapshot), /selected message changed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protected handoff acknowledges only after delayed exact-session editor restoration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-handoff-session-"));
  let handoffPath: string | undefined;
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "draft only" });
    handoffPath = handoff.path;
    assert.equal(statSync(handoff.path).mode & 0o777, 0o600);
    let editor = "";
    const ctx = {
      mode: "tui",
      sessionManager: {
        getSessionFile: () => sessionPath,
        getSessionId: () => "fork-session",
      },
      ui: { setEditorText: (text: string) => { editor = text; } },
    } as any;
    const env = { [HANDOFF_PATH_ENV]: handoff.path, [HANDOFF_NONCE_ENV]: handoff.nonce };
    const readiness = waitForHandoffReady({
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      forkSessionPath: sessionPath,
      forkSessionId: "fork-session",
    }, 250, 5);

    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(existsSync(getHandoffReadyPath(handoff.path)), false);
    assert.equal(restoreEditorFromHandoff(ctx, env), true);
    assert.equal(editor, "draft only");
    assert.equal(existsSync(handoff.path), false, "prompt-bearing handoff is removed before readiness is observed");
    assert.deepEqual(await readiness, { ok: true });
    assert.equal(existsSync(getHandoffReadyPath(handoff.path)), true);
    assert.equal(restoreEditorFromHandoff(ctx, env), false);
    assert.equal(existsSync(getHandoffReadyPath(handoff.path)), true, "a repeated bootstrap must not consume readiness");
  } finally {
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readiness polling sees no partial acknowledgement before atomic publication", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-atomic-ready-"));
  const handoffPaths: string[] = [];
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "draft" });
    handoffPaths.push(handoff.path);
    const readyPath = getHandoffReadyPath(handoff.path);
    const readyData = {
      version: 1 as const,
      forkSessionPath: realpathSync(sessionPath),
      forkSessionId: "fork-session",
      nonce: handoff.nonce,
    };
    let settled = false;
    const readiness = waitForHandoffReady({
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      forkSessionPath: sessionPath,
      forkSessionId: "fork-session",
    }, 250, 2).then((result: unknown) => {
      settled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false);
    assert.equal(existsSync(readyPath), false);
    let publicationBoundaryObserved = false;
    publishHandoffReady(handoff.path, readyData, (temporaryPath: string, finalPath: string) => {
      publicationBoundaryObserved = true;
      assert.equal(finalPath, readyPath);
      assert.equal(existsSync(finalPath), false, "final acknowledgement stays absent until publication");
      assert.equal(settled, false, "polling remains pending before publication");
      assert.equal(statSync(temporaryPath).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(temporaryPath, "utf8")), readyData);
      renameSync(temporaryPath, finalPath);
    });

    assert.equal(publicationBoundaryObserved, true);
    assert.deepEqual(await readiness, { ok: true });

    const failedHandoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "draft" });
    handoffPaths.push(failedHandoff.path);
    assert.throws(() => publishHandoffReady(failedHandoff.path, {
      ...readyData,
      nonce: failedHandoff.nonce,
    }, () => {
      throw new Error("publication failed");
    }), /publication failed/);
    assert.equal(existsSync(getHandoffReadyPath(failedHandoff.path)), false);
    assert.deepEqual(readdirSync(dirname(failedHandoff.path)), ["handoff.json"], "failed publication removes its private temporary file");
  } finally {
    for (const handoffPath of handoffPaths) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing or mismatched readiness acknowledgement fails within the injected timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-readiness-session-"));
  let handoffPath: string | undefined;
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "draft" });
    handoffPath = handoff.path;
    const expected = {
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      forkSessionPath: sessionPath,
      forkSessionId: "fork-session",
    };
    const missing = await waitForHandoffReady(expected, 10, 2);
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /Timed out/);

    writeFileSync(getHandoffReadyPath(handoff.path), JSON.stringify({
      version: 1,
      forkSessionPath: sessionPath,
      forkSessionId: "fork-session",
      nonce: "wrong",
    }) + "\n", { mode: 0o600 });
    const mismatched = await waitForHandoffReady(expected, 100, 2);
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.error ?? "", /mismatched/);
  } finally {
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap editor hydration failure publishes no acknowledgement and removes the prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-bootstrap-failure-"));
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "do not retain" });
    const ctx = {
      mode: "tui",
      sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "fork-session" },
      ui: { setEditorText: () => { throw new Error("editor unavailable"); } },
    } as any;
    assert.equal(restoreEditorFromHandoff(ctx, {
      [HANDOFF_PATH_ENV]: handoff.path,
      [HANDOFF_NONCE_ENV]: handoff.nonce,
    }), false);
    assert.equal(existsSync(handoff.path), false);
    assert.equal(existsSync(getHandoffReadyPath(handoff.path)), false);
    const readiness = await waitForHandoffReady({
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      forkSessionPath: sessionPath,
      forkSessionId: "fork-session",
    }, 10, 2);
    assert.equal(readiness.ok, false);
    assert.match(readiness.error ?? "", /Timed out/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff mismatch never types text and consumes the handoff", () => {
  const dir = mkdtempSync(join(tmpdir(), "fork-to-pane-mismatch-session-"));
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "do not type" });
    let typed = false;
    const ctx = {
      mode: "tui",
      sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "other" },
      ui: { setEditorText: () => { typed = true; } },
    } as any;
    assert.equal(restoreEditorFromHandoff(ctx, {
      [HANDOFF_PATH_ENV]: handoff.path,
      [HANDOFF_NONCE_ENV]: handoff.nonce,
    }), false);
    assert.equal(typed, false);
    assert.equal(existsSync(handoff.path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
