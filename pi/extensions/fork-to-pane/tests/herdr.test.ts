import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPiCommand,
  createHerdrAdapter,
  orientationDirection,
  quoteShellArg,
  type HerdrExecResult,
} from "../herdr.ts";

function ok(stdout = "{}"): HerdrExecResult {
  return { ok: true, stdout, stderr: "" };
}

const env = {
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  HERDR_PANE_ID: "w1:p1",
  HERDR_WORKSPACE_ID: "w1",
  HERDR_TAB_ID: "w1:t1",
} as NodeJS.ProcessEnv;

const readyOptions = {
  waitForReady: async () => ({ ok: true }),
};

test("orientation names map to unambiguous Herdr physical directions", () => {
  assert.equal(orientationDirection("horizontal"), "right");
  assert.equal(orientationDirection("vertical"), "down");
});

test("shell command quotes every argument and does not include editor text", () => {
  assert.equal(quoteShellArg("a'b"), `'a'"'"'b'`);
  const command = buildPiCommand("/tmp/a b/'session.jsonl", "/tmp/ext ' one.ts", {
    model: { provider: "provider ' one", modelId: "model ' two" },
    thinkingLevel: "xhigh",
  });
  assert.equal(
    command,
    `exec 'pi' '--session' '/tmp/a b/'"'"'session.jsonl' '--extension' '/tmp/ext '"'"' one.ts' '--provider' 'provider '"'"' one' '--model' 'model '"'"' two' '--thinking' 'xhigh'`,
  );
  assert.ok(!command.includes("selected prompt"));
});

test("adapter verifies caller identity, splits relative to it, and launches quoted Pi", async () => {
  const calls: string[][] = [];
  const exec = (args: string[]): HerdrExecResult => {
    calls.push(args);
    if (args[0] === "--version") return ok("herdr 0.9.1");
    if (args[1] === "current") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }));
    if (args[1] === "get") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } } }));
    if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
    return ok();
  };
  const adapter = createHerdrAdapter(exec, env, readyOptions);
  assert.deepEqual(adapter.validateSource(), { ok: true, sourcePaneId: "w1:p1" });
  const result = await adapter.launch({
    placement: "horizontal",
    cwd: "/project with space",
    sessionPath: "/sessions/fork.jsonl",
    sessionId: "fork-session",
    bootstrapPath: "/extensions/bootstrap.ts",
    handoffPath: "/tmp/private/handoff.json",
    handoffNonce: "nonce",
    runtimeState: {
      model: { provider: "nondefault-provider", modelId: "nondefault-model" },
      thinkingLevel: "high",
    },
  });
  assert.deepEqual(result, { ok: true, paneId: "w1:p2" });
  assert.deepEqual(calls[3], [
    "pane", "split", "--pane", "w1:p1", "--direction", "right", "--cwd", "/project with space",
    "--env", "PI_FORK_TO_PANE_HANDOFF=/tmp/private/handoff.json",
    "--env", "PI_FORK_TO_PANE_NONCE=nonce", "--no-focus",
  ]);
  assert.deepEqual(calls[4], [
    "pane", "run", "w1:p2",
    "exec 'pi' '--session' '/sessions/fork.jsonl' '--extension' '/extensions/bootstrap.ts' '--provider' 'nondefault-provider' '--model' 'nondefault-model' '--thinking' 'high'",
  ]);
});

test("tab placement targets the captured source workspace and returns its root pane", async () => {
  const calls: string[][] = [];
  const adapter = createHerdrAdapter((args) => {
    calls.push(args);
    if (args[0] === "--version") return ok("herdr");
    if (args[1] === "current") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }));
    if (args[1] === "get") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } } }));
    if (args[0] === "tab" && args[1] === "create") {
      return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } } }));
    }
    return ok();
  }, env, readyOptions);
  assert.equal(adapter.validateSource().ok, true);
  assert.deepEqual(await adapter.launch({
    placement: "tab", cwd: "/project", sessionPath: "/fork", sessionId: "fork-session", bootstrapPath: "/boot",
    handoffPath: "/handoff", handoffNonce: "nonce",
  }), { ok: true, paneId: "w1:p9" });
  assert.deepEqual(calls[3], [
    "tab", "create", "--workspace", "w1", "--cwd", "/project",
    "--env", "PI_FORK_TO_PANE_HANDOFF=/handoff",
    "--env", "PI_FORK_TO_PANE_NONCE=nonce", "--no-focus",
  ]);
  assert.deepEqual(calls[4], ["pane", "run", "w1:p9", "exec 'pi' '--session' '/fork' '--extension' '/boot'"]);
});

test("failed launch in a new tab closes only that returned tab", async () => {
  const calls: string[][] = [];
  const adapter = createHerdrAdapter((args) => {
    calls.push(args);
    if (args[0] === "--version") return ok("herdr");
    if (args[1] === "current") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }));
    if (args[1] === "get") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } } }));
    if (args[0] === "tab" && args[1] === "create") return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } } }));
    if (args[1] === "run") return { ok: false, stdout: "", stderr: "failed", error: "failed" };
    return ok();
  }, env);
  assert.equal(adapter.validateSource().ok, true);
  const result = await adapter.launch({
    placement: "tab", cwd: "/project", sessionPath: "/fork", sessionId: "fork-session", bootstrapPath: "/boot",
    handoffPath: "/handoff", handoffNonce: "nonce",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls.at(-1), ["tab", "close", "w1:t2"]);
});

test("accepted pane command stays pending until readiness acknowledgement", async () => {
  const calls: string[][] = [];
  let acknowledge: ((result: { ok: boolean; error?: string }) => void) | undefined;
  const readiness = new Promise<{ ok: boolean; error?: string }>((resolve) => { acknowledge = resolve; });
  const adapter = createHerdrAdapter((args) => {
    calls.push(args);
    if (args[0] === "--version") return ok("herdr");
    if (args[1] === "current") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }));
    if (args[1] === "get") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } } }));
    if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
    return ok();
  }, env, { waitForReady: async () => readiness });
  assert.equal(adapter.validateSource().ok, true);
  let settled = false;
  const pending = adapter.launch({
    placement: "horizontal", cwd: "/project", sessionPath: "/fork", sessionId: "fork-session", bootstrapPath: "/boot",
    handoffPath: "/handoff", handoffNonce: "nonce",
  }).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);
  assert.deepEqual(calls.at(-1), ["pane", "run", "w1:p2", "exec 'pi' '--session' '/fork' '--extension' '/boot'"]);

  acknowledge!({ ok: true });
  assert.deepEqual(await pending, { ok: true, paneId: "w1:p2" });
});

test("readiness failure closes only the proven pane or tab and never the source", async (t) => {
  for (const placement of ["horizontal", "tab"] as const) {
    await t.test(placement, async () => {
      const calls: string[][] = [];
      const adapter = createHerdrAdapter((args) => {
        calls.push(args);
        if (args[0] === "--version") return ok("herdr");
        if (args[1] === "current") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }));
        if (args[1] === "get") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } } }));
        if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }));
        if (args[0] === "tab" && args[1] === "create") {
          return ok(JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p9" } } }));
        }
        return ok();
      }, env, {
        readinessTimeoutMs: 1,
        waitForReady: async (_expected, timeoutMs) => ({
          ok: false,
          error: `readiness timed out after ${timeoutMs}ms`,
        }),
      });
      assert.equal(adapter.validateSource().ok, true);
      const result = await adapter.launch({
        placement, cwd: "/project", sessionPath: "/fork", sessionId: "fork-session", bootstrapPath: "/boot",
        handoffPath: "/handoff", handoffNonce: "nonce",
      });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /readiness timed out/);
      const expectedClose = placement === "tab" ? ["tab", "close", "w1:t2"] : ["pane", "close", "w1:p2"];
      assert.deepEqual(calls.at(-1), expectedClose);
      assert.ok(!calls.some((call) => call[1] === "close" && call[2] === "w1:p1"));
      assert.ok(!calls.some((call) => call[0] === "tab" && call[1] === "close" && call[2] === "w1:t1"));
    });
  }
});

test("adapter rejects unsupported and mismatched hosts before split", () => {
  let called = false;
  const noHost = createHerdrAdapter(() => { called = true; return ok(); }, {} as NodeJS.ProcessEnv);
  assert.equal(noHost.validateSource().ok, false);
  assert.equal(called, false);

  const mismatch = createHerdrAdapter((args) => {
    if (args[0] === "--version") return ok("herdr");
    return ok(JSON.stringify({ result: { pane: { pane_id: "w1:other" } } }));
  }, env);
  assert.match(mismatch.validateSource().error ?? "", /does not match/);
});

test("launch failure closes only the newly returned pane", async () => {
  const calls: string[][] = [];
  const adapter = createHerdrAdapter((args) => {
    calls.push(args);
    if (args[0] === "--version") return ok("herdr");
    if (args[1] === "current") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1" } } }));
    if (args[1] === "get") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1" } } }));
    if (args[1] === "split") return ok(JSON.stringify({ result: { pane: { pane_id: "w1:new" } } }));
    if (args[1] === "run") return { ok: false, stdout: "", stderr: "failed", error: "failed" };
    return ok();
  }, env);
  assert.equal(adapter.validateSource().ok, true);
  const result = await adapter.launch({
    placement: "vertical", cwd: "/project", sessionPath: "/fork", sessionId: "fork-session", bootstrapPath: "/boot",
    handoffPath: "/handoff", handoffNonce: "nonce",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(calls.at(-1), ["pane", "close", "w1:new"]);
  assert.ok(!calls.some((call) => call[1] === "close" && call[2] === "w1:p1"));
});
