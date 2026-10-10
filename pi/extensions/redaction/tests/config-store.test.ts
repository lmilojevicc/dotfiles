import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigStoreError, createPrivateConfigStore } from "../src/config-store.ts";
import { offConfig } from "../src/config.ts";
import type { ExtensionConfig } from "../src/contracts.ts";

const secret = "synthetic-private@example.test";
const draft = (): ExtensionConfig => ({ ...offConfig(), literals: { [secret]: "MAIL_ALIAS" } });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "redaction-store-"));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  return { directory, path, store: createPrivateConfigStore(path), lock: join(directory, ".config.json.lock") };
}
async function rejects(operation: Promise<unknown>, code: string, path?: string) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof ConfigStoreError);
    assert.equal(error.code, code);
    assert.equal(error.message, `Private configuration ${code}.`);
    assert.equal("cause" in error, false);
    assert.ok(!String(error.stack).includes(secret));
    if (path) assert.ok(!String(error.stack).includes(path));
    return true;
  });
}
async function patch<K extends keyof typeof fs>(name: K, replacement: typeof fs[K], run: () => Promise<void>) {
  const original = fs[name];
  fs[name] = replacement;
  syncBuiltinESMExports();
  try { await run(); }
  finally { fs[name] = original; syncBuiltinESMExports(); }
}

test("config-store: absent read never creates directories or a file and is all-off", async t => {
  const { directory } = await fixture(t);
  const path = join(directory, ".config", "pi-redaction", "config.json");
  const store = createPrivateConfigStore(path);
  const first = await store.read();
  assert.deepEqual(first.config, offConfig());
  assert.equal(first.path, path);
  assert.ok(first.revision && !first.revision.includes(path));
  assert.equal((await store.read()).revision, first.revision);
  assert.deepEqual(await readdir(directory), []);
});

test("config-store: explicit first save creates bounded directory suffix 0700 and config 0600", async t => {
  const { directory } = await fixture(t);
  const parent = join(directory, "xdg", "pi-redaction");
  const path = join(parent, "config.json");
  const store = createPrivateConfigStore(path);
  const absent = await store.read();
  const saved = await store.save(absent, draft());
  assert.deepEqual(saved.config, draft());
  assert.equal(saved.warnings, undefined);
  assert.notEqual(saved.revision, absent.revision);
  assert.equal((await lstat(join(directory, "xdg"))).mode & 0o777, 0o700);
  assert.equal((await lstat(parent)).mode & 0o777, 0o700);
  assert.equal((await lstat(path)).mode & 0o777, 0o600);
  assert.equal((await store.read()).revision, saved.revision);
  const next = await store.save(saved, offConfig());
  assert.equal((await store.read()).revision, next.revision);
  assert.deepEqual(await readdir(parent), ["config.json"]);
});

test("config-store: exact whitespace, multiline and prototype-like literal keys survive repeated saves", async t => {
  const { store, path } = await fixture(t);
  const config = { ...offConfig(), literals: Object.fromEntries([["  synthetic\n\t ", "A1"], ["__proto__", "A2"], ["constructor", "A3"], ["toString", "A4"]]) };
  const result = await store.save(await store.read(), config);
  assert.deepEqual((await store.read()).config, config);
  assert.equal(Object.hasOwn(result.config.literals, "__proto__"), true);
  assert.ok((await readFile(path, "utf8")).includes("__proto__"));
  assert.deepEqual((await store.save(result, config)).config, config);
});

test("config-store: refuses malformed JSON, duplicate keys and schema, leaving bytes unchanged", async t => {
  const { store, path, directory } = await fixture(t);
  for (const text of [secret, '{"sources":{"userMessages":false,"userMessages":true}}', '{"extra":"synthetic"}', '{"literals":{"a":"X","b":"X"}}']) {
    await writeFile(path, text, { mode: 0o600 });
    await rejects(store.read(), "invalid", path);
    await rejects(store.save({ path, revision: "wrong", config: offConfig() }, offConfig()), "invalid", path);
    assert.equal(await readFile(path, "utf8"), text);
    assert.deepEqual(await readdir(directory), ["config.json"]);
  }
});

test("config-store: draft validation and write bounds apply before any creation", async t => {
  const { directory } = await fixture(t);
  const path = join(directory, "new", "config.json");
  const store = createPrivateConfigStore(path);
  const snapshot = await store.read();
  await rejects(store.save(snapshot, { ...offConfig(), sources: { toolResults: secret } } as unknown as ExtensionConfig), "invalid", path);
  await rejects(store.save(snapshot, { ...offConfig(), literals: { ["x".repeat(1024 * 1024)]: "Y" } }), "invalid", path);
  assert.deepEqual(await readdir(directory), []);
});

test("config-store: exact 1MiB file accepted, oversize rejected before read", async t => {
  const { store, path } = await fixture(t);
  await writeFile(path, "{}" + " ".repeat(1024 * 1024 - 2), { mode: 0o600 });
  assert.deepEqual((await store.read()).config, offConfig());
  await writeFile(path, "{}" + " ".repeat(1024 * 1024 - 1));
  const original = fs.open;
  let targetOpened = false;
  await patch("open", (async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === path) targetOpened = true;
    return original(...args);
  }) as typeof fs.open, async () => { await rejects(store.read(), "invalid", path); });
  assert.equal(targetOpened, false);
});

test("config-store: bounded read detects growth rather than unbounded readFile", async t => {
  const { store, path } = await fixture(t);
  await writeFile(path, "{}", { mode: 0o600 });
  const original = fs.open;
  let maximumRead = 0;
  let readBytes = 0;
  await patch("open", (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[0] === path) {
      const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number | null) => {
        if (!readBytes) await writeFile(path, "{}" + " ".repeat(1024 * 1024));
        maximumRead = Math.max(maximumRead, length);
        const result = await read(buffer, offset, length, position);
        readBytes += result.bytesRead;
        return result;
      }) as typeof handle.read;
      handle.readFile = async () => { throw new Error("unbounded read prohibited"); };
    }
    return handle;
  }) as typeof fs.open, async () => { await rejects(store.read(), "invalid", path); });
  assert.ok(maximumRead <= 64 * 1024);
  assert.equal(readBytes, 1024 * 1024 + 1);
});

test("config-store: rejects unsafe file/directory permissions without chmod/reset", async t => {
  const { store, path, directory } = await fixture(t);
  await writeFile(path, "{}", { mode: 0o644 });
  await rejects(store.read(), "unsafe", path);
  assert.equal((await lstat(path)).mode & 0o777, 0o644);
  await chmod(path, 0o600);
  const expected = await store.read();
  await chmod(directory, 0o722);
  await rejects(store.read(), "unsafe", path);
  await rejects(store.save(expected, draft()), "unsafe", path);
  assert.equal((await lstat(directory)).mode & 0o777, 0o722);
  assert.equal(await readFile(path, "utf8"), "{}");
});

test("config-store: file and parent symlinks, directory target and FIFO are refused without hanging", async t => {
  const { store, path, directory } = await fixture(t);
  const target = join(directory, "target");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, path);
  await rejects(store.read(), "unsafe", path);
  await rm(path);
  await mkdir(path, { mode: 0o700 });
  await rejects(store.read(), "unsafe", path);
  await rm(path, { recursive: true });
  const parentLink = join(directory, "parent-link");
  await symlink(directory, parentLink);
  await rejects(createPrivateConfigStore(join(parentLink, "config.json")).read(), "unsafe");
  await new Promise<void>((done, reject) => {
    const child = spawn("mkfifo", [path]);
    child.on("error", reject); child.on("exit", code => code === 0 ? done() : reject(new Error("synthetic FIFO setup failed")));
  });
  await rejects(store.read(), "unsafe", path);
  assert.equal(await readFile(target, "utf8"), "{}");
});

test("config-store: rejects wrong file and immediate-parent owners (synthetic stat injection)", async t => {
  const { store, path, directory } = await fixture(t);
  await writeFile(path, "{}", { mode: 0o600 });
  const original = fs.lstat;
  for (const affected of [path, directory]) {
    await patch("lstat", (async (...args: Parameters<typeof fs.lstat>) => {
      const info = await original(...args);
      if (args[0] !== affected) return info;
      const copy = Object.create(info);
      Object.defineProperty(copy, "uid", { value: BigInt(process.getuid!() + 1) });
      return copy;
    }) as typeof fs.lstat, async () => { await rejects(store.read(), "unsafe", path); });
  }
});

test("config-store: bounded missing suffix and unsafe creation anchor are refused", async t => {
  const { directory } = await fixture(t);
  const path = join(directory, ...Array.from({ length: 17 }, (_, i) => `d${i}`), "config.json");
  await rejects(createPrivateConfigStore(path).read(), "unsafe", path);
  await chmod(directory, 0o777);
  await rejects(createPrivateConfigStore(join(directory, "new", "config.json")).read(), "unsafe");
  assert.deepEqual(await readdir(directory), []);
});

test("config-store: external content edits, deletion, replacement and parent replacement conflict", async t => {
  const { directory } = await fixture(t);
  const parent = join(directory, "app");
  await mkdir(parent, { mode: 0o700 });
  const path = join(parent, "config.json");
  const store = createPrivateConfigStore(path);
  const original = await store.save(await store.read(), draft());
  await writeFile(path, "{}");
  await rejects(store.save(original, draft()), "conflict", path);
  const edited = await store.read();
  await rm(path);
  await rejects(store.save(edited, draft()), "conflict", path);
  const absent = await store.read();
  await writeFile(path, "{}", { mode: 0o600 });
  await rejects(store.save(absent, draft()), "conflict", path);
  const replaced = await store.read();
  await fs.rename(parent, join(directory, "old-app"));
  await mkdir(parent, { mode: 0o700 });
  await writeFile(path, "{}", { mode: 0o600 });
  await rejects(store.save(replaced, draft()), "conflict", path);
  assert.equal(await readFile(path, "utf8"), "{}");
});

test("config-store: an external creator of a missing directory is a conflict", async t => {
  const { directory } = await fixture(t);
  const parent = join(directory, "app");
  const store = createPrivateConfigStore(join(parent, "config.json"));
  const absent = await store.read();
  await mkdir(parent, { mode: 0o700 });
  await rejects(store.save(absent, draft()), "conflict");
  assert.deepEqual(await readdir(parent), []);
});

test("config-store: in-process queue serializes store instances and refuses second stale save", async t => {
  const { store, path, directory } = await fixture(t);
  const other = createPrivateConfigStore(path);
  const expected = await store.read();
  const results = await Promise.allSettled([store.save(expected, draft()), other.save(expected, offConfig())]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected") assert.equal(results[1].reason.code, "conflict");
  assert.deepEqual((await store.read()).config, draft());
  assert.deepEqual(await readdir(directory), ["config.json"]);
});

test("config-store: cooperative lock never waits indefinitely, steals or deletes existing entry", async t => {
  const { store, lock, directory } = await fixture(t);
  const expected = await store.read();
  await writeFile(lock, "synthetic other lock", { mode: 0o600 });
  await rejects(store.save(expected, draft()), "busy");
  assert.equal(await readFile(lock, "utf8"), "synthetic other lock");
  await rm(lock);
  await symlink(directory, lock);
  await rejects(store.save(expected, draft()), "busy");
  assert.equal((await lstat(lock)).isSymbolicLink(), true);
});

test("config-store: cooperating independent processes cannot both save the same snapshot", { timeout: 10_000 }, async t => {
  const { store, path, directory } = await fixture(t);
  const modulePath = fileURLToPath(new URL("../src/config-store.ts", import.meta.url));
  const source = `import {createPrivateConfigStore} from ${JSON.stringify(modulePath)}; const s=createPrivateConfigStore(process.argv[1]); const e=await s.read(); process.stdout.write('ready\\n'); process.stdin.once('data',async()=>{try{await s.save(e,e.config);process.stdout.write('saved\\n');}catch(e){process.stdout.write(e.code+'\\n');}process.stdin.destroy();});`;
  const children = [0, 1].map(() => spawn(process.execPath, ["--input-type=module", "-e", source, path], { stdio: ["pipe", "pipe", "pipe"] }));
  t.after(() => { for (const child of children) child.kill(); });
  const outputs: string[] = [];
  const completions = children.map(child => new Promise<void>((done, reject) => {
    let text = ""; let errors = "";
    child.stdout.on("data", data => { text += String(data); });
    child.stderr.on("data", data => { errors += String(data); });
    child.on("error", reject);
    child.on("exit", code => { if (code !== 0 || errors) reject(new Error("synthetic child failed")); else { outputs.push(text); done(); } });
  }));
  await Promise.all(children.map(child => new Promise<void>(done => { child.stdout.once("data", () => done()); })));
  for (const child of children) child.stdin.write("go\n");
  await Promise.all(completions);
  assert.equal(outputs.filter(text => text === "ready\nsaved\n").length, 1);
  assert.equal(outputs.filter(text => text === "ready\nbusy\n" || text === "ready\nconflict\n").length, 1);
  assert.deepEqual((await store.read()).config, offConfig());
  assert.deepEqual(await readdir(directory), ["config.json"]);
});

test("config-store: atomic rename failure preserves bytes and cleans owned temp and lock", async t => {
  const { store, path, directory } = await fixture(t);
  const expected = await store.save(await store.read(), offConfig());
  const originalBytes = await readFile(path);
  await patch("rename", (async () => { throw new Error(secret, { cause: new Error(path) }); }) as typeof fs.rename, async () => {
    await rejects(store.save(expected, draft()), "io", path);
  });
  assert.deepEqual(await readFile(path), originalBytes);
  assert.deepEqual(await readdir(directory), ["config.json"]);
  assert.equal((await store.read()).revision, expected.revision);
});

test("config-store: partial temp-write or precommit fsync failure preserves existing bytes", async t => {
  const { store, path, directory } = await fixture(t);
  const expected = await store.save(await store.read(), offConfig());
  const original = fs.open;
  const originalBytes = await readFile(path);
  for (const failure of ["write", "sync"]) {
    await patch("open", (async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(".tmp")) {
        if (failure === "write") {
          const write = handle.writeFile.bind(handle);
          handle.writeFile = async () => { await write("partial synthetic"); throw new Error(secret); };
        } else handle.sync = async () => { throw new Error(secret); };
      }
      return handle;
    }) as typeof fs.open, async () => { await rejects(store.save(expected, draft()), "io", path); });
    assert.deepEqual(await readFile(path), originalBytes);
    assert.deepEqual(await readdir(directory), ["config.json"]);
  }
});

test("config-store: failed initial save cleans only owned empty newly created directories", async t => {
  const { directory } = await fixture(t);
  const path = join(directory, "xdg", "app", "config.json");
  const store = createPrivateConfigStore(path);
  const expected = await store.read();
  await patch("link", (async () => { throw new Error(secret); }) as typeof fs.link, async () => {
    await rejects(store.save(expected, draft()), "io", path);
  });
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await store.read()).revision, expected.revision);
});

test("config-store: directory identity changes before commit refuse without touching moved file", async t => {
  const { directory } = await fixture(t);
  const parent = join(directory, "app");
  await mkdir(parent, { mode: 0o700 });
  const path = join(parent, "config.json");
  const store = createPrivateConfigStore(path);
  const expected = await store.save(await store.read(), offConfig());
  const original = fs.open;
  await patch("open", (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await fs.rename(parent, join(directory, "moved"));
        await mkdir(parent, { mode: 0o700 });
      };
    }
    return handle;
  }) as typeof fs.open, async () => { await rejects(store.save(expected, draft()), "conflict", path); });
  assert.deepEqual(await readdir(parent), []);
  assert.equal(await readFile(join(directory, "moved", "config.json"), "utf8"), JSON.stringify(offConfig()) + "\n");
});

test("config-store: postcommit directory fsync warning still reports applied save and usable revision", async t => {
  const { store, directory } = await fixture(t);
  const expected = await store.read();
  const original = fs.open;
  await patch("open", (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[0] === directory && (Number(args[1]) & constants.O_DIRECTORY)) {
      const sync = handle.sync.bind(handle);
      let count = 0;
      handle.sync = async () => { if (++count > 1) throw new Error(secret); await sync(); };
    }
    return handle;
  }) as typeof fs.open, async () => {
    const saved = await store.save(expected, draft());
    assert.deepEqual(saved.warnings, ["durability"]);
    assert.deepEqual((await store.read()).config, draft());
    assert.equal((await store.read()).revision, saved.revision);
  });
  const current = await store.read();
  assert.equal((await store.save(current, offConfig())).warnings, undefined);
});

test("config-store: postcommit lock cleanup failure is a value-free warning, not unapplied failure", async t => {
  const { store, lock } = await fixture(t);
  const expected = await store.read();
  const original = fs.unlink;
  await patch("unlink", (async (...args: Parameters<typeof fs.unlink>) => {
    if (args[0] === lock) throw new Error(secret, { cause: new Error(lock) });
    return original(...args);
  }) as typeof fs.unlink, async () => {
    const saved = await store.save(expected, draft());
    assert.deepEqual(saved.warnings, ["cleanup"]);
    assert.equal((await store.read()).revision, saved.revision);
    await rejects(store.save(saved, offConfig()), "busy");
  });
  assert.equal((await lstat(lock)).isFile(), true);
});

test("config-store: never removes another actor's replacement lock during cleanup", async t => {
  const { store, lock } = await fixture(t);
  const initial = await store.save(await store.read(), offConfig());
  const original = fs.rename;
  await patch("rename", (async (...args: Parameters<typeof fs.rename>) => {
    await original(...args);
    // Keep the old inode alive so the replacement cannot reuse its identity.
    await original(lock, lock + ".old");
    await writeFile(lock, "synthetic other owner entry", { mode: 0o600 });
  }) as typeof fs.rename, async () => {
    const saved = await store.save(initial, draft());
    assert.deepEqual(saved.warnings, ["cleanup"]);
  });
  assert.equal(await readFile(lock, "utf8"), "synthetic other owner entry");
});

test("config-store: invalid snapshot/path and generic filesystem failures reveal no private data", async t => {
  const { store, path } = await fixture(t);
  const expected = await store.read();
  await rejects(store.save({ ...expected, path: path + "other" }, draft()), "conflict", path);
  await rejects(createPrivateConfigStore("relative-synthetic").read(), "unsafe");
  await patch("lstat", (async () => { throw Object.assign(new Error(secret, { cause: new Error(path) }), { code: "EIO" }); }) as typeof fs.lstat, async () => {
    await rejects(store.read(), "io", path);
    await rejects(store.save(expected, draft()), "io", path);
  });
});

test("config-store: exact 1MiB serialization succeeds and one byte more leaves saved bytes intact", async t => {
  const { store, path } = await fixture(t);
  const baseline = { ...offConfig(), literals: { x: "Z" } };
  const length = 1024 * 1024 - Buffer.byteLength(JSON.stringify(baseline) + "\n") + 1;
  const config = { ...offConfig(), literals: { ["x".repeat(length)]: "Z" } };
  const saved = await store.save(await store.read(), config);
  assert.equal((await lstat(path)).size, 1024 * 1024);
  assert.equal((await store.read()).revision, saved.revision);
  await rejects(store.save(saved, { ...offConfig(), literals: { ["x".repeat(length + 1)]: "Z" } }), "invalid", path);
  assert.equal((await store.read()).revision, saved.revision);
});

test("config-store: unusual owner-masking umask refuses missing dirs but fd-created files remain 0600", async t => {
  const { directory, store, path } = await fixture(t);
  const missingStore = createPrivateConfigStore(join(directory, "app", "config.json"));
  const missing = await missingStore.read();
  const expected = await store.read();
  const previous = process.umask(0o777);
  try {
    await rejects(missingStore.save(missing, draft()), "unsafe");
    assert.deepEqual(await readdir(directory), []);
    const saved = await store.save(expected, draft());
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.equal((await store.read()).revision, saved.revision);
  } finally { process.umask(previous); }
});

test("config-store: exclusive creation detects a late destination creator without overwriting it", async t => {
  const { store, path, directory } = await fixture(t);
  const expected = await store.read();
  const original = fs.link;
  await patch("link", (async (...args: Parameters<typeof fs.link>) => {
    await writeFile(path, "{}", { mode: 0o600 });
    return original(...args);
  }) as typeof fs.link, async () => { await rejects(store.save(expected, draft()), "conflict", path); });
  assert.equal(await readFile(path, "utf8"), "{}");
  assert.deepEqual(await readdir(directory), ["config.json"]);
});

test("config-store: failure after exclusively opening the lock cleans its owned inode", async t => {
  const { store, directory } = await fixture(t);
  const expected = await store.read();
  const original = fs.open;
  await patch("open", (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith(".lock")) handle.chmod = async () => { throw new Error(secret); };
    return handle;
  }) as typeof fs.open, async () => { await rejects(store.save(expected, draft()), "io"); });
  assert.deepEqual(await readdir(directory), []);
});

test("config-store: replaced temporary entry is refused and never deleted during owned cleanup", async t => {
  const { store, path, directory } = await fixture(t);
  const expected = await store.save(await store.read(), offConfig());
  const originalBytes = await readFile(path);
  const original = fs.open;
  let replacedPath = "";
  await patch("open", (async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]).endsWith(".tmp")) {
      replacedPath = String(args[0]);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await fs.unlink(replacedPath);
        await writeFile(replacedPath, "synthetic replacement entry", { mode: 0o600 });
      };
    }
    return handle;
  }) as typeof fs.open, async () => { await rejects(store.save(expected, draft()), "conflict", path); });
  assert.deepEqual(await readFile(path), originalBytes);
  assert.equal(await readFile(replacedPath, "utf8"), "synthetic replacement entry");
  assert.equal((await readdir(directory)).length, 2);
});

test("config-store: ConfigStoreError sanitizes runtime-invalid codes rather than exposing caller text", () => {
  const error = new ConfigStoreError(secret as "io");
  assert.equal(error.code, "io");
  assert.equal(error.message, "Private configuration io.");
  assert.equal("cause" in error, false);
});
