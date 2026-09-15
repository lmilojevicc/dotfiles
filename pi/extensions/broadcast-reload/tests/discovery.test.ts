import assert from "node:assert/strict";
import test from "node:test";
import {
  createDiscoveryClient,
  findUncoveredPiProcesses,
  isPiCommand,
  parsePsOutput,
  parseTasklistOutput,
} from "../discovery.ts";

test("isPiCommand matches real pi sessions and rejects lookalikes", () => {
  assert.equal(isPiCommand("pi"), true);
  assert.equal(isPiCommand("/opt/homebrew/bin/pi"), true);
  assert.equal(isPiCommand("/opt/homebrew/bin/pi --session abc"), true);
  assert.equal(
    isPiCommand("node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    true
  );
  assert.equal(isPiCommand("/opt/homebrew/Cellar/node/26.8.1/bin/node /opt/homebrew/bin/pi"), true);

  assert.equal(isPiCommand(""), false);
  assert.equal(isPiCommand("   "), false);
  assert.equal(isPiCommand("/opt/homebrew/bin/pinchtab server"), false);
  assert.equal(
    isPiCommand(
      "/opt/homebrew/Cellar/node/26.8.1/bin/node /Users/tester/.pi/agent/npm/node_modules/pi-intercom/broker/broker.ts"
    ),
    false
  );
  assert.equal(
    isPiCommand(
      "/opt/homebrew/Cellar/node/26.8.1/bin/node --require tsx/dist/preflight.cjs --import tsx/dist/loader.mjs broker.ts"
    ),
    false
  );
  assert.equal(isPiCommand("/usr/bin/node worker.js"), false);
  assert.equal(isPiCommand("vim pi-notes.txt"), false);
});

test("parsePsOutput skips header/helpers and keeps pi sessions", () => {
  const stdout = [
    "  PID COMMAND",
    "  123 /opt/homebrew/bin/pi",
    "  456 node /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    "  789 /bin/bash -c grep pi",
    "  101 /opt/homebrew/Cellar/node/26.8.1/bin/node /Users/tester/.pi/agent/npm/node_modules/pi-intercom/broker/broker.ts",
    "  102 /opt/homebrew/bin/pinchtab server",
    "  103 /usr/bin/node worker.js",
    "not a process line",
    "",
  ].join("\n");

  const parsed = parsePsOutput(stdout);
  assert.deepEqual(
    parsed.map((proc) => proc.pid),
    [123, 456]
  );
});

test("parseTasklistOutput parses CSV rows conservatively", () => {
  const stdout = [
    '"node.exe","1234","Console","1","50,000 K"',
    '"pi.exe","5678","Console","1","10,000 K"',
    "malformed row",
  ].join("\n");

  const parsed = parseTasklistOutput(stdout);
  // node.exe rows are intentionally NOT matched: without a command line we
  // cannot prove they are pi sessions.
  if (process.platform === "win32") {
    assert.deepEqual(
      parsed.map((proc) => proc.pid),
      [5678]
    );
  } else {
    assert.deepEqual(parsed, []);
  }
});

test("findUncoveredPiProcesses excludes sender and covered PIDs", () => {
  const processes = [
    { pid: 100, command: "pi" },
    { pid: 200, command: "pi" },
    { pid: 300, command: "pi" },
  ];
  const uncovered = findUncoveredPiProcesses(processes, new Set([200]), 100);
  assert.deepEqual(
    uncovered.map((proc) => proc.pid),
    [300]
  );
});

test("createDiscoveryClient delegates to the runner and reports outages", () => {
  const okClient = createDiscoveryClient(() => ({
    ok: true,
    stdout: "  PID COMMAND\n  111 pi\n  222 pi\n",
  }));
  const okRes = okClient.listPiProcesses();
  assert.equal(okRes.available, true);
  assert.deepEqual(
    okRes.processes.map((proc) => proc.pid),
    [111, 222]
  );

  const downClient = createDiscoveryClient(() => ({ ok: false, stdout: "", error: "no ps" }));
  const downRes = downClient.listPiProcesses();
  assert.equal(downRes.available, false);
  assert.deepEqual(downRes.processes, []);
  assert.equal(downRes.error, "no ps");
});
