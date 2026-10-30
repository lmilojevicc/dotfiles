import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildPiCommand, resolvePiLauncher, type PiLauncher } from "../host.ts";
import { createTmuxAdapter } from "../tmux.ts";

const launcher: PiLauncher = { command: "/opt/pi/node", prefixArgs: ["/opt/pi/lib/cli.js"] };

test("a node-run Pi is launched through the same interpreter and script", () => {
  const dir = mkdtempSync(join(tmpdir(), "session-to-pane-launcher-"));
  try {
    const script = join(dir, "cli.js");
    writeFileSync(script, "");
    assert.deepEqual(
      resolvePiLauncher("/opt/pi/node", ["/opt/pi/node", script, "--session", "x"], () => true, {}),
      { command: "/opt/pi/node", prefixArgs: [script] },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an npm .bin symlink is followed to the script it runs", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "session-to-pane-launcher-")));
  try {
    const script = join(dir, "cli.js");
    writeFileSync(script, "");
    mkdirSync(join(dir, ".bin"));
    const bin = join(dir, ".bin", "pi");
    symlinkSync("../cli.js", bin);
    assert.deepEqual(resolvePiLauncher("/usr/bin/node", ["/usr/bin/node", bin, "--session", "x"], undefined, {}), {
      command: "/usr/bin/node",
      prefixArgs: [script],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a managed install relaunches through its own pi wrapper", () => {
  const env = { PI_MANAGED_INSTALL_ROOT: "/home/u/.pi/agent/install" };
  const seen: string[] = [];
  const exists = (path: string) => (seen.push(path), path === "/home/u/.pi/agent/bin/pi");
  assert.deepEqual(resolvePiLauncher("/usr/bin/node", ["/usr/bin/node", "/x/.bin/pi"], exists, env), {
    command: "/home/u/.pi/agent/bin/pi",
    prefixArgs: [],
  });
  // Without the wrapper on disk it falls back to the running script.
  assert.equal(resolvePiLauncher("/usr/bin/node", ["/usr/bin/node", "relative"], () => false, env), undefined);
});

test("a compiled Pi binary is its own launcher", () => {
  assert.deepEqual(
    resolvePiLauncher("/opt/pi/dist/pi", ["/opt/pi/dist/pi", "--session", "x"], () => true, {}),
    { command: "/opt/pi/dist/pi", prefixArgs: [] },
  );
});

test("an interpreter without an identifiable script yields no launcher", () => {
  assert.equal(resolvePiLauncher("/opt/node/bin/node", ["/opt/node/bin/node"], () => true, {}), undefined);
  assert.equal(resolvePiLauncher("/opt/node/bin/node", ["/opt/node/bin/node", "--version"], () => true, {}), undefined);
  assert.equal(
    resolvePiLauncher("/opt/node/bin/node", ["/opt/node/bin/node", "/missing/cli.js"], () => false, {}),
    undefined,
  );
  assert.equal(
    resolvePiLauncher("/opt/node/bin/node", ["/opt/node/bin/node", "relative/cli.js"], () => true, {}),
    undefined,
  );
  assert.equal(resolvePiLauncher("/opt/node/bin/node", [], () => true, {}), undefined);
});

test("the built command uses the resolved launcher and never the bare name", () => {
  const command = buildPiCommand("/sessions/fork.jsonl", "/ext/bootstrap.ts", undefined, launcher);
  assert.equal(
    command,
    "exec '/opt/pi/node' '/opt/pi/lib/cli.js' '--session' '/sessions/fork.jsonl' '--extension' '/ext/bootstrap.ts'",
  );
  assert.equal(
    buildPiCommand("/fork", "/boot", undefined, { command: "/opt/pi/dist/pi", prefixArgs: [] }),
    "exec '/opt/pi/dist/pi' '--session' '/fork' '--extension' '/boot'",
  );
  // Without an injected launcher the command pins the process that loaded this file instead of `pi`.
  const resolved = buildPiCommand("/fork", "/boot");
  assert.ok(resolved.startsWith("exec '"));
  assert.ok(!resolved.startsWith("exec 'pi'"));
});

test("the tmux adapter launches the resolved launcher inside the quoted command", async () => {
  const calls: string[][] = [];
  const adapter = createTmuxAdapter((args) => {
    calls.push(args);
    if (args[2] === "list-panes") return { ok: true, stdout: "%1\t$2\t@3\t4242\n", stderr: "" };
    return { ok: true, stdout: "%8\t$2\t@3\n", stderr: "" };
  }, { TMUX: "/tmp/sock,4242,2", TMUX_PANE: "%1" } as NodeJS.ProcessEnv, {
    piLauncher: launcher,
    waitForReady: async () => ({ ok: true }),
  });
  assert.equal(adapter.validateSource().ok, true);
  const result = await adapter.launch({
    placement: "horizontal",
    cwd: "/project",
    sessionPath: "/fork",
    sessionId: "fork-session",
    bootstrapPath: "/boot",
    handoffPath: "/handoff",
    handoffNonce: "nonce",
  });
  assert.equal(result.ok, true);
  assert.match(calls[1][5], /exec '\/opt\/pi\/node' '\/opt\/pi\/lib\/cli.js' '--session'/);
});
