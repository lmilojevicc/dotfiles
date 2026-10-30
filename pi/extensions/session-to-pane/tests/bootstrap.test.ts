import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadModule } from "./runtime.ts";

const bootstrap = await loadModule<{ default(pi: any): void }>("../bootstrap.ts");
const {
  HANDOFF_NONCE_ENV,
  HANDOFF_PATH_ENV,
  cleanupHandoff,
  createHandoff,
  getHandoffReadyPath,
} = await loadModule<any>("../session.ts");

test("bootstrap registers only a session_start handoff restore", () => {
  const handlers = new Map<string, Function[]>();
  bootstrap.default({
    on(event: string, handler: Function) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
  });
  assert.deepEqual([...handlers.keys()], ["session_start"]);
  let typed = false;
  handlers.get("session_start")![0]({}, {
    mode: "tui",
    sessionManager: { getSessionFile: () => "/unused", getSessionId: () => "unused", getSessionDir: () => "", getEntry: () => undefined },
    ui: { setEditorText: () => { typed = true; } },
  });
  assert.equal(typed, false, "missing handoff environment is a safe no-op");
});

test("bootstrap hydration failure removes the prompt and acknowledges the reason to the parent", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-bootstrap-test-"));
  const previousPath = process.env[HANDOFF_PATH_ENV];
  const previousNonce = process.env[HANDOFF_NONCE_ENV];
  let handoffPath: string | undefined;
  try {
    const sessionPath = join(dir, "fork.jsonl");
    writeFileSync(sessionPath, `${JSON.stringify({
      type: "session",
      version: 3,
      id: "fork-session",
      timestamp: new Date().toISOString(),
      cwd: dir,
    })}\n`, { mode: 0o600 });
    const handoff = createHandoff({
      path: sessionPath,
      sessionId: "fork-session",
      editorText: "sensitive draft",
    });
    handoffPath = handoff.path;
    process.env[HANDOFF_PATH_ENV] = handoff.path;
    process.env[HANDOFF_NONCE_ENV] = handoff.nonce;

    const handlers = new Map<string, Function[]>();
    bootstrap.default({
      on(event: string, handler: Function) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
      },
    });
    handlers.get("session_start")![0]({}, {
      mode: "tui",
      sessionManager: { getSessionFile: () => sessionPath, getSessionId: () => "fork-session" },
      ui: { setEditorText: () => { throw new Error("editor unavailable"); } },
    });

    assert.equal(existsSync(handoff.path), false, "the prompt-bearing handoff is consumed");
    assert.equal(existsSync(dirname(handoff.path)), true, "the parent-owned directory is not deleted by the child");
    const acknowledgement = JSON.parse(readFileSync(getHandoffReadyPath(handoff.path), "utf8"));
    assert.equal(acknowledgement.ok, false);
    assert.equal(acknowledgement.nonce, handoff.nonce);
    assert.match(acknowledgement.reason, /editor unavailable/);
  } finally {
    if (previousPath === undefined) delete process.env[HANDOFF_PATH_ENV];
    else process.env[HANDOFF_PATH_ENV] = previousPath;
    if (previousNonce === undefined) delete process.env[HANDOFF_NONCE_ENV];
    else process.env[HANDOFF_NONCE_ENV] = previousNonce;
    if (handoffPath) cleanupHandoff(handoffPath);
    rmSync(dir, { recursive: true, force: true });
  }
});
