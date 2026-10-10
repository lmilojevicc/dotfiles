import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

test("settings-source-only: inactive import and readonly/usage invocation need no store, addon or UI peers", async t => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-redaction-settings-source-only-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const copy = join(temporary, "package");
  for (const name of ["index.ts", "src", "package.json"]) await cp(join(source, name), join(copy, name), { recursive: true });
  // The real persistence seam is intentionally absent in this UI worktree; no actual config is read.
  await rm(join(copy, "src/config-store.ts"), { force: true });
  const script = `
    const { default: install } = await import(${JSON.stringify(pathToFileURL(join(copy, "index.ts")).href)});
    const { offConfig } = await import(${JSON.stringify(pathToFileURL(join(copy, "src/config.ts")).href)});
    const commands = new Map(); const notices = [];
    const pi = { registerCommand(name, value) { commands.set(name, value); }, on() { throw Error('inactive hook'); }, registerTool() { throw Error('inactive tool'); } };
    await install(pi, { loadConfig: async () => ({ state: 'inactive', path: '/synthetic/config.json', config: offConfig() }) });
    if (commands.size !== 2) throw Error('missing commands');
    for (const mode of ['rpc', 'json', 'print']) await commands.get('redaction').handler('synthetic-private-argument', { mode, hasUI: mode === 'rpc', ui: { notify(text) { notices.push(text); } } });
    await commands.get('redaction').handler('synthetic-private-argument', { mode: 'tui', hasUI: true, ui: { notify(text) { notices.push(text); } } });
    if (notices.join().includes('synthetic-private-argument')) throw Error('argument leaked');
    if (notices.length !== 4) throw Error('missing refusal');
    console.log('source-only inactive and readonly invocation passed');
  `;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: copy, env: { ...process.env, XDG_CONFIG_HOME: join(temporary, "absent-private-config") }, encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /source-only inactive/);
  assert.deepEqual(await readdir(temporary), ["package"], "no config/directory creation");
});
