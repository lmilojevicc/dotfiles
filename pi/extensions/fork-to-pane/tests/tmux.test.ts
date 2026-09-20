import assert from "node:assert/strict";
import test from "node:test";
import { buildPiCommand } from "../host.ts";
import {
  createTmuxAdapter,
  escapeTmuxFormatLiteral,
  parseTmuxEnvironment,
  serializeTmuxCommand,
  type TmuxExecResult,
} from "../tmux.ts";

function ok(stdout = ""): TmuxExecResult {
  return { ok: true, stdout, stderr: "" };
}

const socketPath = "/tmp/tmux,socket";
const env = {
  TMUX: `${socketPath},4242,2`,
  TMUX_PANE: "%1",
} as NodeJS.ProcessEnv;
const sourceOutput = "%1\t$2\t@3\t4242\n";

function request(placement: "horizontal" | "vertical" | "tab" = "horizontal") {
  return {
    placement,
    cwd: "/project with ' quote",
    sessionPath: "/sessions/fork ' one.jsonl",
    sessionId: "fork-session",
    bootstrapPath: "/extensions/bootstrap ' one.ts",
    handoffPath: "/tmp/private/handoff ' one.json",
    handoffNonce: "nonce ' one",
    runtimeState: {
      model: { provider: "provider ' one", modelId: "model ' two" },
      thinkingLevel: "xhigh" as const,
    },
  };
}

const readyOptions = {
  waitForReady: async () => ({ ok: true }),
};

test("TMUX is parsed from the right and requires an absolute socket and strict pane ID", () => {
  assert.deepEqual(parseTmuxEnvironment(env), {
    ok: true,
    identity: { socketPath, serverPid: "4242", sessionId: "2", paneId: "%1" },
  });
  assert.match(parseTmuxEnvironment({ TMUX_PANE: "%1" }).error ?? "", /missing/);
  assert.match(parseTmuxEnvironment({ TMUX: "relative,1,0", TMUX_PANE: "%1" }).error ?? "", /malformed/);
  assert.match(parseTmuxEnvironment({ TMUX: "/tmp/sock,pid,0", TMUX_PANE: "%1" }).error ?? "", /malformed/);
  assert.match(parseTmuxEnvironment({ TMUX: "/tmp/sock,1,0" }).error ?? "", /pane identity/);
  assert.match(parseTmuxEnvironment({ TMUX: "/tmp/sock,1,0", TMUX_PANE: "1" }).error ?? "", /pane identity/);
});

test("adapter pins validation to the TMUX socket and captures stable source IDs", () => {
  const calls: string[][] = [];
  const adapter = createTmuxAdapter((args) => {
    calls.push(args);
    return ok(sourceOutput);
  }, env);
  assert.deepEqual(adapter.validateSource(), {
    ok: true,
    source: { socketPath, serverPid: "4242", paneId: "%1", sessionId: "$2", windowId: "@3" },
  });
  assert.deepEqual(calls, [[
    "-S", socketPath,
    "list-panes", "-s", "-t", "$2", "-F",
    "#{pane_id}\t#{session_id}\t#{window_id}\t#{pid}",
  ]]);
});

test("originating linked-window session comes from TMUX and pane membership is resolved in that session", () => {
  const linkedEnv = { TMUX: `${socketPath},4242,0`, TMUX_PANE: "%1" } as NodeJS.ProcessEnv;
  const calls: string[][] = [];
  const adapter = createTmuxAdapter((args) => {
    calls.push(args);
    return ok("%9\t$0\t@8\t4242\n%1\t$0\t@3\t4242\n");
  }, linkedEnv);
  assert.deepEqual(adapter.validateSource(), {
    ok: true,
    source: { socketPath, serverPid: "4242", paneId: "%1", sessionId: "$0", windowId: "@3" },
  });
  assert.equal(calls[0][5], "$0");
});

test("nested mutation commands quote values before tmux parses them again", () => {
  assert.equal(
    serializeTmuxCommand(["cmd", "a;b", "$HOME", 'a"b', "line\nnext", "~user", "back\\slash"]),
    '"cmd" "a;b" "\\$HOME" "a\\"b" "line\\nnext" "\\~user" "back\\\\slash"',
  );
});

test("split and window cwd values preserve literal tmux format characters", async (t) => {
  for (const [name, cwd, escaped] of [
    ["ordinary path", "/project/plain", "/project/plain"],
    ["literal hash", "/project/literal-#-hash", "/project/literal-##-hash"],
    ["format expression", "/project/literal-#{pid}", "/project/literal-##{pid}"],
    ["existing doubled hash", "/project/literal-##{pid}", "/project/literal-####{pid}"],
  ] as const) {
    await t.test(name, async (t) => {
      assert.equal(escapeTmuxFormatLiteral(cwd), escaped);
      for (const placement of ["horizontal", "tab"] as const) {
        await t.test(placement, async () => {
          const calls: string[][] = [];
          const adapter = createTmuxAdapter((args) => {
            calls.push(args);
            if (args[2] === "list-panes") return ok(sourceOutput);
            return ok(placement === "tab" ? "%9\t$2\t@4\n" : "%8\t$2\t@3\n");
          }, env, readyOptions);
          assert.equal(adapter.validateSource().ok, true);
          assert.equal((await adapter.launch({ ...request(placement), cwd })).ok, true);
          assert.ok(calls[1][5].includes(serializeTmuxCommand(["-c", escaped])));
        });
      }
    });
  }
});

test("missing executable, stale pane/server, and malformed validation output fail closed", async (t) => {
  await t.test("executable absence", () => {
    const adapter = createTmuxAdapter(() => ({ ok: false, stdout: "", stderr: "", error: "spawnSync tmux ENOENT" }), env);
    assert.match(adapter.validateSource().error ?? "", /ENOENT/);
  });
  for (const [name, output] of [
    ["stale pane", "%9\t$2\t@3\t4242\n"],
    ["stale server", "%1\t$2\t@3\t9999\n"],
    ["wrong originating session", "%1\t$9\t@3\t4242\n"],
    ["malformed output", "%1 $2 @3 4242\n"],
  ] as const) {
    await t.test(name, () => {
      const adapter = createTmuxAdapter(() => ok(output), env);
      assert.match(adapter.validateSource().error ?? "", /does not match/);
    });
  }
});

test("horizontal and vertical splits are detached, pinned, targeted, and launch quoted Pi", async (t) => {
  for (const placement of ["horizontal", "vertical"] as const) {
    await t.test(placement, async () => {
      const calls: string[][] = [];
      const adapter = createTmuxAdapter((args) => {
        calls.push(args);
        if (args[2] === "list-panes") return ok(sourceOutput);
        return ok("%8\t$2\t@3\n");
      }, env, readyOptions);
      assert.equal(adapter.validateSource().ok, true);
      assert.deepEqual(await adapter.launch(request(placement)), { ok: true, paneId: "%8" });
      const creationCommand = [
        "split-window", "-d", "-P", "-F", "#{pane_id}\t#{session_id}\t#{window_id}",
        placement === "horizontal" ? "-h" : "-v",
        "-t", "$2:@3.%1",
        "-c", "/project with ' quote",
        "-e", "PI_FORK_TO_PANE_HANDOFF=/tmp/private/handoff ' one.json",
        "-e", "PI_FORK_TO_PANE_NONCE=nonce ' one",
        buildPiCommand("/sessions/fork ' one.jsonl", "/extensions/bootstrap ' one.ts", request().runtimeState),
      ];
      assert.deepEqual(calls[1], [
        "-S", socketPath,
        "if-shell", "-F", "#{==:#{pid},4242}",
        serializeTmuxCommand(creationCommand),
        serializeTmuxCommand(["display-message", "-p", "fork-to-pane-server-identity-mismatch"]),
      ]);
      assert.ok(calls.every((call) => call[0] === "-S" && call[1] === socketPath));
      assert.ok(!calls[1][5].includes("selected prompt"));
    });
  }
});

test("tab placement creates a detached window in the captured source session", async () => {
  const calls: string[][] = [];
  let readinessExpectation: any;
  const adapter = createTmuxAdapter((args) => {
    calls.push(args);
    if (args[2] === "list-panes") return ok(sourceOutput);
    return ok("%9\t$2\t@4\n");
  }, env, {
    waitForReady: async (expected) => {
      readinessExpectation = expected;
      return { ok: true };
    },
  });
  assert.equal(adapter.validateSource().ok, true);
  assert.deepEqual(await adapter.launch(request("tab")), { ok: true, paneId: "%9" });
  const creationCommand = [
    "new-window", "-d", "-P", "-F", "#{pane_id}\t#{session_id}\t#{window_id}",
    "-t", "$2:",
    "-c", "/project with ' quote",
    "-e", "PI_FORK_TO_PANE_HANDOFF=/tmp/private/handoff ' one.json",
    "-e", "PI_FORK_TO_PANE_NONCE=nonce ' one",
    buildPiCommand("/sessions/fork ' one.jsonl", "/extensions/bootstrap ' one.ts", request().runtimeState),
  ];
  assert.equal(calls[1][5], serializeTmuxCommand(creationCommand));
  assert.deepEqual(readinessExpectation, {
    handoffPath: "/tmp/private/handoff ' one.json",
    nonce: "nonce ' one",
    forkSessionPath: "/sessions/fork ' one.jsonl",
    forkSessionId: "fork-session",
  });
});

test("creation errors and unproven returned identities never trigger cleanup", async (t) => {
  await t.test("creation error", async () => {
    const calls: string[][] = [];
    const adapter = createTmuxAdapter((args) => {
      calls.push(args);
      if (args[2] === "list-panes") return ok(sourceOutput);
      return { ok: false, stdout: "", stderr: "failed", error: "creation failed" };
    }, env, readyOptions);
    assert.equal(adapter.validateSource().ok, true);
    assert.match((await adapter.launch(request())).error ?? "", /creation failed/);
    assert.equal(calls.length, 2);
  });

  for (const [name, placement, output] of [
    ["malformed", "horizontal", "not ids\n"],
    ["wrong session", "horizontal", "%8\t$9\t@3\n"],
    ["source pane reused", "horizontal", "%1\t$2\t@3\n"],
    ["wrong split window", "vertical", "%8\t$2\t@9\n"],
    ["source window reused", "tab", "%8\t$2\t@3\n"],
  ] as const) {
    await t.test(name, async () => {
      const calls: string[][] = [];
      const adapter = createTmuxAdapter((args) => {
        calls.push(args);
        return args[2] === "list-panes" ? ok(sourceOutput) : ok(output);
      }, env, readyOptions);
      assert.equal(adapter.validateSource().ok, true);
      const result = await adapter.launch(request(placement));
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /invalid new/);
      assert.equal(calls.length, 2, "an unproven target must not be killed");
    });
  }
});

test("replacement server before creation is rejected by the atomic ownership guard", async () => {
  const calls: string[][] = [];
  const adapter = createTmuxAdapter((args) => {
    calls.push(args);
    if (args[2] === "list-panes") return ok(sourceOutput);
    return ok("fork-to-pane-server-identity-mismatch\n");
  }, env, readyOptions);
  assert.equal(adapter.validateSource().ok, true);
  const result = await adapter.launch(request());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /server identity changed/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][2], "if-shell");
  assert.equal(calls[1][4], "#{==:#{pid},4242}");
  assert.ok(calls[1][5].startsWith('"split-window"'));
});

test("readiness failure closes only the proven new pane or window on the pinned server", async (t) => {
  for (const placement of ["horizontal", "tab"] as const) {
    await t.test(placement, async () => {
      const calls: string[][] = [];
      const createdOutput = placement === "tab" ? "%9\t$2\t@4\n" : "%8\t$2\t@3\n";
      const adapter = createTmuxAdapter((args) => {
        calls.push(args);
        if (args[2] === "list-panes") return ok(sourceOutput);
        if (args[5]?.startsWith('"split-window"') || args[5]?.startsWith('"new-window"')) return ok(createdOutput);
        return ok();
      }, env, {
        readinessTimeoutMs: 1,
        waitForReady: async (_expected, timeoutMs) => ({ ok: false, error: `timed out after ${timeoutMs}ms` }),
      });
      assert.equal(adapter.validateSource().ok, true);
      const result = await adapter.launch(request(placement));
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /timed out/);
      assert.deepEqual(calls.at(-1), [
        "-S", socketPath,
        "if-shell", "-F", "#{==:#{pid},4242}",
        serializeTmuxCommand(placement === "tab"
          ? ["kill-window", "-t", "$2:@4"]
          : ["kill-pane", "-t", "$2:@3.%8"]),
        serializeTmuxCommand(["display-message", "-p", "fork-to-pane-server-identity-mismatch"]),
      ]);
      assert.ok(!calls.some((call) => call[5]?.includes('"%1"')));
      assert.ok(!calls.some((call) => call[5]?.includes('"@3"') && call[5]?.startsWith('"kill-window"')));
      assert.ok(calls.every((call) => call[0] === "-S" && call[1] === socketPath));
    });
  }
});

test("replacement server during readiness is never mutated by cleanup", async () => {
  const calls: string[][] = [];
  const adapter = createTmuxAdapter((args) => {
    calls.push(args);
    if (args[2] === "list-panes") return ok(sourceOutput);
    if (args[5]?.startsWith('"split-window"')) return ok("%8\t$2\t@3\n");
    return ok("fork-to-pane-server-identity-mismatch\n");
  }, env, {
    waitForReady: async () => ({ ok: false, error: "readiness timed out" }),
  });
  assert.equal(adapter.validateSource().ok, true);
  const result = await adapter.launch(request());
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /readiness timed out/);
  assert.match(result.cleanupError ?? "", /server identity changed/);
  assert.equal(calls.length, 3);
  assert.equal(calls[2][4], "#{==:#{pid},4242}");
  assert.equal(calls[2][5], serializeTmuxCommand(["kill-pane", "-t", "$2:@3.%8"]));
});

test("cleanup failure is reported without changing the proven cleanup target", async () => {
  const calls: string[][] = [];
  const adapter = createTmuxAdapter((args) => {
    calls.push(args);
    if (args[2] === "list-panes") return ok(sourceOutput);
    if (args[5]?.startsWith('"split-window"')) return ok("%8\t$2\t@3\n");
    return { ok: false, stdout: "", stderr: "kill failed", error: "kill failed" };
  }, env, {
    waitForReady: async () => { throw new Error("readiness failed"); },
  });
  assert.equal(adapter.validateSource().ok, true);
  const result = await adapter.launch(request());
  assert.match(result.error ?? "", /readiness failed/);
  assert.equal(result.cleanupError, "kill failed");
  assert.equal(calls.at(-1)?.[5], serializeTmuxCommand(["kill-pane", "-t", "$2:@3.%8"]));
});
