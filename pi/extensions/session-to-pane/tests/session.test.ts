import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadModule, loadPi } from "./runtime.ts";

const { SessionManager } = await loadPi<any>();
const {
  HANDOFF_NONCE_ENV,
  HANDOFF_PATH_ENV,
  captureCloneSnapshot,
  captureForkSnapshot,
  captureTreeSnapshot,
  cleanupHandoff,
  createForkFromSnapshot,
  createFullTreeFromSnapshot,
  createHandoff,
  getForkCandidates,
  getHandoffReadyPath,
  POSITION_MARKER_TYPE,
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-session-"));
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-root-"));
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-first-model-"));
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-first-thinking-"));
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-root-runtime-"));
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-stale-"));
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

test("complete-tree clone preserves alternate branches and reopens at the runtime leaf", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-clone-"));
  try {
    const timestamp = new Date().toISOString();
    const entries = [
      message("u1", null, "user", "root"),
      message("a1", "u1", "assistant", "answer"),
      modelChange("m1", "a1", "historical-provider", "historical-model"),
      thinkingChange("t1", "m1", "xhigh"),
      message("u2", "t1", "user", "main branch"),
      message("a2", "u2", "assistant", "main answer"),
      { type: "custom_message", id: "c1", parentId: "a1", timestamp, customType: "fixture", content: [{ type: "text", text: "alternate draft" }, { type: "image", data: "image" }], display: true, details: { branch: 2 } },
      { type: "custom", id: "x1", parentId: "c1", timestamp, customType: "fixture-state", data: { nested: [1, 2] } },
      { type: "label", id: "l1", parentId: "x1", timestamp, targetId: "c1", label: "alternate" },
      { type: "session_info", id: "s1", parentId: "l1", timestamp, name: "tree fixture" },
      { type: "branch_summary", id: "b1", parentId: "s1", timestamp, fromId: "a2", summary: "abandoned", details: { kept: true }, fromHook: true },
    ];
    const file = writeSession(dir, entries);
    const source = SessionManager.open(file, dir);
    source.branch("a2");
    const beforeBytes = readFileSync(file, "utf8");
    const beforeEntries = structuredClone(source.getEntries());
    const runtimeState = {
      model: { provider: "runtime-provider", modelId: "runtime-model" },
      thinkingLevel: "high" as const,
    };

    const snapshot = captureCloneSnapshot(source, "unsent editor draft", runtimeState);
    const created = createFullTreeFromSnapshot(snapshot, source);
    const copy = SessionManager.open(created.path, dir);
    const copiedEntries = copy.getEntries();
    const marker = copiedEntries.at(-1);

    assert.notEqual(created.path, file);
    assert.notEqual(created.sessionId, "source-session");
    assert.equal(copy.getHeader()?.parentSession, file);
    assert.deepEqual(copiedEntries.slice(0, -1), beforeEntries);
    assert.equal(marker?.type, "custom");
    assert.equal((marker as any).customType, POSITION_MARKER_TYPE);
    assert.equal(marker?.parentId, "a2");
    assert.deepEqual((marker as any).data, { sourceLeafId: "a2", mode: "clone" });
    assert.equal(copy.getLeafId(), marker?.id);
    assert.equal(created.editorText, "unsent editor draft");
    assert.deepEqual(created.launchState, runtimeState);
    assert.deepEqual(copy.buildSessionContext().messages, source.buildSessionContext().messages);
    assert.equal(source.getLeafId(), "a2");
    assert.equal(readFileSync(file, "utf8"), beforeBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("complete-tree clone accepts freshly appended live entries with omitted optional fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-live-clone-"));
  try {
    const file = writeSession(dir, [message("u1", null, "user", "root")]);
    const source = SessionManager.open(file, dir);
    const customId = source.appendCustomEntry("fixture");
    const labelId = source.appendLabelChange("u1", undefined);
    const beforeBytes = readFileSync(file, "utf8");

    assert.equal(Object.hasOwn(source.getEntry(customId)!, "data"), true);
    assert.equal(Object.hasOwn(source.getEntry(labelId)!, "label"), true);
    const created = createFullTreeFromSnapshot(captureCloneSnapshot(source, "live draft"), source);
    const copy = SessionManager.open(created.path, dir);
    const copiedEntries = copy.getEntries().slice(0, -1);

    assert.equal(created.editorText, "live draft");
    assert.deepEqual(copiedEntries, readFileSync(file, "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line)));
    assert.equal(copy.getEntries().at(-1)?.parentId, labelId);
    assert.equal(source.getLeafId(), labelId);
    assert.equal(readFileSync(file, "utf8"), beforeBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tree copy accepts a freshly appended custom message and cleared label", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-live-tree-"));
  try {
    const file = writeSession(dir, [message("u1", null, "user", "root")]);
    const source = SessionManager.open(file, dir);
    const customId = source.appendCustomMessageEntry("fixture", "custom draft", true);
    const labelId = source.appendLabelChange(customId, undefined);
    const beforeBytes = readFileSync(file, "utf8");

    assert.equal(Object.hasOwn(source.getEntry(customId)!, "details"), true);
    assert.equal(Object.hasOwn(source.getEntry(labelId)!, "label"), true);
    const created = createFullTreeFromSnapshot(captureTreeSnapshot(source, customId), source);
    const copy = SessionManager.open(created.path, dir);

    assert.equal(created.editorText, "custom draft");
    assert.equal(copy.getEntries().at(-1)?.parentId, "u1");
    assert.deepEqual(copy.getEntries().slice(0, -1), readFileSync(file, "utf8").trim().split("\n").slice(1).map((line) => JSON.parse(line)));
    assert.equal(source.getLeafId(), labelId);
    assert.equal(readFileSync(file, "utf8"), beforeBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("root-only complete-tree clone reopens through a root marker with runtime launch state", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-root-clone-"));
  try {
    const file = writeSession(dir, [message("u1", null, "user", "only prompt")]);
    const source = SessionManager.open(file, dir);
    source.resetLeaf();
    const runtimeState = {
      model: { provider: "runtime-provider", modelId: "runtime-model" },
      thinkingLevel: "max" as const,
    };
    const created = createFullTreeFromSnapshot(captureCloneSnapshot(source, "draft", runtimeState), source);
    const copy = SessionManager.open(created.path, dir);
    const entries = copy.getEntries();

    assert.deepEqual(entries.slice(0, -1), source.getEntries());
    assert.equal(entries.at(-1)?.parentId, null);
    assert.equal(copy.getLeafId(), entries.at(-1)?.id);
    assert.deepEqual(created.launchState, runtimeState);
    assert.deepEqual(copy.buildSessionContext().messages, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tree copies use native draft and target-position semantics without changing the source", () => {
  const scenarios = [
    { selected: "u1", target: null, editor: "root" },
    { selected: "c1", target: "a1", editor: "custom text" },
    { selected: "a1", target: "a1", editor: "" },
    { selected: "m1", target: "m1", editor: "" },
  ];
  for (const scenario of scenarios) {
    const dir = mkdtempSync(join(tmpdir(), `session-to-pane-tree-${scenario.selected}-`));
    try {
      const timestamp = new Date().toISOString();
      const file = writeSession(dir, [
        message("u1", null, "user", "root"),
        message("a1", "u1", "assistant", "answer"),
        { type: "custom_message", id: "c1", parentId: "a1", timestamp, customType: "fixture", content: [{ type: "text", text: "custom " }, { type: "image", data: "x" }, { type: "text", text: "text" }], display: true },
        modelChange("m1", "c1", "provider", "model"),
      ]);
      const source = SessionManager.open(file, dir);
      source.branch("a1");
      const beforeBytes = readFileSync(file, "utf8");
      const beforeLeaf = source.getLeafId();
      const snapshot = captureTreeSnapshot(source, scenario.selected, {
        model: { provider: "runtime", modelId: "current" },
        thinkingLevel: "medium",
      });
      const created = createFullTreeFromSnapshot(snapshot, source);
      const copy = SessionManager.open(created.path, dir);
      const marker = copy.getEntries().at(-1);

      assert.equal(created.editorText, scenario.editor, scenario.selected);
      assert.equal(marker?.parentId, scenario.target, scenario.selected);
      assert.deepEqual((marker as any).data, { sourceLeafId: scenario.target, mode: "tree" });
      assert.deepEqual(created.launchState, {
        model: { provider: "runtime", modelId: "current" },
        thinkingLevel: "medium",
      });
      assert.equal(source.getLeafId(), beforeLeaf);
      assert.equal(readFileSync(file, "utf8"), beforeBytes);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("complete-tree creation rejects stale source bytes and clone runtime position before copying", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-stale-tree-"));
  try {
    const file = writeSession(dir, [message("u1", null, "user", "root"), message("a1", "u1", "assistant", "answer")]);
    const source = SessionManager.open(file, dir);
    source.branch("u1");
    const snapshot = captureCloneSnapshot(source, "draft");
    source.branch("a1");
    assert.throws(() => createFullTreeFromSnapshot(snapshot, source), /position changed/i);
    assert.equal(readdirSync(dir).length, 1);

    source.branch("u1");
    const changed = captureCloneSnapshot(source, "draft");
    writeFileSync(file, readFileSync(file, "utf8") + "\n");
    assert.throws(() => createFullTreeFromSnapshot(changed, source), /source session changed/i);
    assert.equal(readdirSync(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mid-copy failure removes only the identified partial destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-partial-copy-"));
  const originalForkFrom = SessionManager.forkFrom;
  try {
    const file = writeSession(dir, [message("u1", null, "user", "root")]);
    const source = SessionManager.open(file, dir);
    const snapshot = captureCloneSnapshot(source, "draft");
    (SessionManager as any).forkFrom = (sourcePath: string, cwd: string, sessionDir: string, options: { id: string }) => {
      const partial = join(sessionDir, `partial_${options.id}.jsonl`);
      writeFileSync(partial, JSON.stringify({
        type: "session",
        version: 3,
        id: options.id,
        timestamp: new Date().toISOString(),
        cwd,
        parentSession: sourcePath,
      }) + "\n");
      throw new Error("injected mid-copy failure");
    };

    assert.throws(() => createFullTreeFromSnapshot(snapshot, source), /injected mid-copy failure/);
    assert.deepEqual(readdirSync(dir), ["source-session.jsonl"]);
  } finally {
    (SessionManager as any).forkFrom = originalForkFrom;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("protected handoff acknowledges only after delayed exact-session editor restoration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-handoff-session-"));
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
      sessionPath: sessionPath,
      sessionId: "fork-session",
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-atomic-ready-"));
  const handoffPaths: string[] = [];
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "draft" });
    handoffPaths.push(handoff.path);
    const readyPath = getHandoffReadyPath(handoff.path);
    const readyData = {
      version: 1 as const,
      sessionPath: realpathSync(sessionPath),
      sessionId: "fork-session",
      nonce: handoff.nonce,
    };
    let settled = false;
    const readiness = waitForHandoffReady({
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      sessionPath: sessionPath,
      sessionId: "fork-session",
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
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-readiness-session-"));
  let handoffPath: string | undefined;
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "draft" });
    handoffPath = handoff.path;
    const expected = {
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      sessionPath: sessionPath,
      sessionId: "fork-session",
    };
    const missing = await waitForHandoffReady(expected, 10, 2);
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /Timed out/);

    writeFileSync(getHandoffReadyPath(handoff.path), JSON.stringify({
      version: 1,
      sessionPath: sessionPath,
      sessionId: "fork-session",
      nonce: "wrong",
    }) + "\n", { mode: 0o600 });
    const mismatched = await waitForHandoffReady(expected, 100, 2);
    assert.equal(mismatched.ok, false);
    assert.match(mismatched.error ?? "", /mismatched/);

    for (const rejection of [
      { version: 1, ok: false, nonce: handoff.nonce, reason: "" },
      { version: 1, ok: false, nonce: handoff.nonce },
      { version: 1, ok: false, nonce: handoff.nonce, reason: "x".repeat(513) },
    ]) {
      writeFileSync(getHandoffReadyPath(handoff.path), JSON.stringify(rejection) + "\n", { mode: 0o600 });
      const invalid = await waitForHandoffReady(expected, 100, 2);
      assert.equal(invalid.ok, false);
      assert.match(invalid.error ?? "", /invalid readiness acknowledgement/);
    }
  } finally {
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bootstrap editor hydration failure publishes the reason instead of deleting the parent directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-bootstrap-failure-"));
  let handoffPath: string | undefined;
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "do not retain" });
    handoffPath = handoff.path;
    const ctx = {
      mode: "tui",
      sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "fork-session" },
      ui: { setEditorText: () => { throw new Error("editor unavailable"); } },
    } as any;
    const readiness = waitForHandoffReady({
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      sessionPath: sessionPath,
      sessionId: "fork-session",
    }, 60_000, 5);
    assert.equal(restoreEditorFromHandoff(ctx, {
      [HANDOFF_PATH_ENV]: handoff.path,
      [HANDOFF_NONCE_ENV]: handoff.nonce,
    }), false);
    assert.equal(existsSync(handoff.path), false, "the prompt-bearing handoff is still consumed");
    assert.equal(existsSync(dirname(handoff.path)), true, "the parent-owned directory is left for the parent");
    const result = await readiness;
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /could not restore the editor: restoring the editor failed: editor unavailable/);
  } finally {
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff mismatch never types text and reports the mismatch to the waiting parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-mismatch-session-"));
  let handoffPath: string | undefined;
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "do not type" });
    handoffPath = handoff.path;
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
    const acknowledgement = JSON.parse(readFileSync(getHandoffReadyPath(handoff.path), "utf8"));
    assert.deepEqual({
      version: acknowledgement.version,
      ok: acknowledgement.ok,
      nonce: acknowledgement.nonce,
    }, { version: 1, ok: false, nonce: handoff.nonce });
    assert.match(acknowledgement.reason, /session id does not match/);
    const readiness = await waitForHandoffReady({
      handoffPath: handoff.path,
      nonce: handoff.nonce,
      sessionPath: sessionPath,
      sessionId: "fork-session",
    }, 60_000, 5);
    assert.equal(readiness.ok, false);
    assert.match(readiness.error ?? "", /could not restore the editor: the child session id does not match/);
  } finally {
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nonce mismatch is acknowledged so the parent reports it instead of timing out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-nonce-mismatch-"));
  let handoffPath: string | undefined;
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "do not type" });
    handoffPath = handoff.path;
    const ctx = {
      mode: "tui",
      sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "fork-session" },
      ui: { setEditorText: () => { throw new Error("must not type"); } },
    } as any;
    assert.equal(restoreEditorFromHandoff(ctx, {
      [HANDOFF_PATH_ENV]: handoff.path,
      [HANDOFF_NONCE_ENV]: "expected-nonce",
    }), false);
    const readiness = await waitForHandoffReady({
      handoffPath: handoff.path,
      nonce: "expected-nonce",
      sessionPath: sessionPath,
      sessionId: "fork-session",
    }, 60_000, 5);
    assert.equal(readiness.ok, false);
    assert.match(readiness.error ?? "", /mismatched readiness acknowledgement/);
  } finally {
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unusable handoff is left alone so the parent keeps ownership of its directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-unsafe-handoff-"));
  let handoffPath: string | undefined;
  try {
    const sessionPath = writeSession(dir, [], "fork-session");
    const handoff = createHandoff({ path: sessionPath, sessionId: "fork-session", editorText: "unsafe" });
    handoffPath = handoff.path;
    chmodSync(handoff.path, 0o644);
    const ctx = {
      mode: "tui",
      sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "fork-session" },
      ui: { setEditorText: () => {} },
    } as any;
    assert.equal(restoreEditorFromHandoff(ctx, {
      [HANDOFF_PATH_ENV]: handoff.path,
      [HANDOFF_NONCE_ENV]: handoff.nonce,
    }), false);
    assert.equal(existsSync(handoff.path), true, "an unreadable handoff is not deleted by the child");
    assert.equal(existsSync(getHandoffReadyPath(handoff.path)), false, "an unvalidated handoff is not acknowledged");
  } finally {
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});
