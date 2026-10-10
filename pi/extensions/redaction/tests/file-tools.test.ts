import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createFileSession } from "../src/file-tools.ts";
import type { Redactor, RedactionResult } from "../src/contracts.ts";

// Synthetic exact matcher, no native engine, Pi, private config, or real secrets.
function mock(literals: Record<string, string> = {}, automatic: Record<string, string> = {}): Redactor {
  const entries = [...Object.entries(literals).map(([raw, alias]) => ({ raw, alias, kind: "literal" as const })),
    ...Object.entries(automatic).map(([raw, alias]) => ({ raw, alias, kind: "email" as const }))]
    .sort((a, b) => b.raw.length - a.raw.length);
  return {
    redact(text): RedactionResult {
      const matches: RedactionResult["matches"] = [];
      let result = "";
      for (let i = 0; i < text.length;) {
        const match = entries.find(e => text.startsWith(e.raw, i));
        if (match) {
          matches.push({ start: i, end: i + match.raw.length, replacement: match.alias, kind: match.kind });
          result += match.alias;
          i += match.raw.length;
        } else result += text[i++];
      }
      return { text: result, matches };
    },
    reset() {},
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }, literals: Record<string, string> = {}, automatic: Record<string, string> = {}) {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "pi-file-tools-")));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const session = createFileSession({ cwd, redactor: mock(literals, automatic), literalMappings: literals });
  const put = (name: string, content: string) => fs.writeFile(path.join(cwd, name), content);
  const get = (name: string) => fs.readFile(path.join(cwd, name), "utf8");
  return { cwd, session, put, get };
}
const refused = /Redaction file operation refused:/;

test("file-tools: literal filename resolves before first read and read never modifies disk", async t => {
  const f = await fixture(t, { "alex@example.test": "PRIVATE_EMAIL" });
  await f.put("report-alex@example.test.txt", "contact alex@example.test\n");
  const result = await f.session.read({ path: "report-PRIVATE_EMAIL.txt" });
  assert.equal(result.text, "contact PRIVATE_EMAIL\n");
  assert.equal(result.path, path.join(f.cwd, "report-PRIVATE_EMAIL.txt"));
  assert.equal(await f.get("report-alex@example.test.txt"), "contact alex@example.test\n");
  await f.session.edit({ path: result.path, oldText: "contact PRIVATE_EMAIL", newText: "owner PRIVATE_EMAIL" });
  assert.equal(await f.get("report-alex@example.test.txt"), "owner alex@example.test\n");
});

test("file-tools: automatic paths resolve only whole known paths", async t => {
  const f = await fixture(t, {}, { "alex@example.test": "[EMAIL_1]" });
  await f.put("alex@example.test.txt", "hello");
  await assert.rejects(f.session.read({ path: "[EMAIL_1].txt" }), /unknown masked path/);
  const masked = await f.session.rememberPath("alex@example.test.txt");
  assert.equal((await f.session.read({ path: masked })).text, "hello");
  assert.equal((await f.session.read({ path: "[EMAIL_1].txt" })).text, "hello");
  await assert.rejects(f.session.write({ path: "copy-[EMAIL_1].txt", content: "hello" }), /unknown masked path/);
  await assert.rejects(f.session.rememberPath("[EMAIL_1].txt"), /ambiguous trusted path/);
});

test("file-tools: UTF-16 spans preserve unicode and repeated tokens in the edited range", async t => {
  const f = await fixture(t, { "é😀-private": "PRIVATE_VALUE" });
  await f.put("a.txt", "😀 é😀-private / é😀-private tail");
  await f.session.read({ path: "a.txt" });
  const result = await f.session.edit({ path: "a.txt", oldText: "PRIVATE_VALUE / PRIVATE_VALUE", newText: "PRIVATE_VALUE + PRIVATE_VALUE" });
  assert.equal(result.text, "😀 PRIVATE_VALUE + PRIVATE_VALUE tail");
  assert.equal(await f.get("a.txt"), "😀 é😀-private + é😀-private tail");
  await f.session.write({ path: "a.txt", content: "new 😀 PRIVATE_VALUE\n" });
  assert.equal(await f.get("a.txt"), "new 😀 é😀-private\n");
});

test("file-tools: edit requires observation and a unique exact nonempty match", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "repeat repeat");
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "repeat", newText: "x" }), /read the file/);
  await f.session.read({ path: "a.txt" });
  for (const oldText of ["repeat", "missing", ""]) {
    await assert.rejects(f.session.edit({ path: "a.txt", oldText, newText: "x" }), refused);
  }
  assert.equal(await f.get("a.txt"), "repeat repeat");
});

test("file-tools: partial-token edits and cross-range alias injection are refused", async t => {
  const f = await fixture(t, { "secret-a": "PRIVATE_A", "secret-b": "PRIVATE_B" });
  await f.put("a.txt", "first secret-a\nsecond secret-b\n");
  await f.session.read({ path: "a.txt" });
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "PRIVATE_", newText: "x" }), refused);
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "first PRIVATE_A", newText: "first PRIVATE_B" }), /not observed in the edited range/);
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "second", newText: "PRIVATE_A" }), /not observed in the edited range/);
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "second PRIVATE_B", newText: "[EMAIL_999]" }), /unknown opaque alias/);
  assert.equal(await f.get("a.txt"), "first secret-a\nsecond secret-b\n");
});

test("file-tools: aliases observed in other files cannot be restored", async t => {
  const f = await fixture(t, {}, { "a@example.test": "[EMAIL_1]" });
  await f.put("a.txt", "a@example.test");
  await f.put("b.txt", "ordinary");
  await f.session.read({ path: "a.txt" });
  await f.session.read({ path: "b.txt" });
  await assert.rejects(f.session.write({ path: "b.txt", content: "[EMAIL_1]" }), /not observed/);
  await assert.rejects(f.session.write({ path: "c.txt", content: "[EMAIL_1]" }), /not observed/);
  await assert.rejects(f.session.write({ path: "c.txt", content: "[API_TOKEN_77]" }), /unknown opaque alias/);
  await assert.rejects(f.session.write({ path: "c.txt", content: "[API_TOKEN_1]" }), /unknown opaque alias/);
});

test("file-tools: partial views cannot authorize hidden edits or whole-file writes", async t => {
  const f = await fixture(t, { "secret-a": "PRIVATE_A", "secret-b": "PRIVATE_B" });
  await f.put("a.txt", "visible secret-a\nhidden secret-b\nlast\n");
  assert.equal((await f.session.read({ path: "a.txt", limit: 1 })).text, "visible PRIVATE_A\n");
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "hidden PRIVATE_B", newText: "x" }), /outside the observed view/);
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "visible PRIVATE_A", newText: "PRIVATE_B" }), /not observed/);
  await assert.rejects(f.session.write({ path: "a.txt", content: "replacement" }), /requires a full read/);
  const result = await f.session.edit({ path: "a.txt", oldText: "visible PRIVATE_A", newText: "updated PRIVATE_A\nextra" });
  assert.equal(result.text, "updated PRIVATE_A\nextra\n");
  assert.ok(!result.text.includes("PRIVATE_B"));
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "hidden", newText: "x" }), /outside the observed view/);
  assert.equal(await f.get("a.txt"), "updated secret-a\nextra\nhidden secret-b\nlast\n");
});

test("file-tools: latest read replaces authorization, lines sliced after multiline redaction", async t => {
  const f = await fixture(t, { "first\nsecret": "PRIVATE_BLOCK" });
  await f.put("a.txt", "header\nfirst\nsecret\nfooter\n");
  assert.equal((await f.session.read({ path: "a.txt", offset: 2, limit: 1 })).text, "PRIVATE_BLOCK\n");
  await f.session.edit({ path: "a.txt", oldText: "PRIVATE_BLOCK", newText: "PRIVATE_BLOCK!" });
  assert.equal(await f.get("a.txt"), "header\nfirst\nsecret!\nfooter\n");
  await f.session.read({ path: "a.txt", offset: 3 });
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "header", newText: "x" }), /outside the observed view/);
  for (const input of [{ offset: 0 }, { limit: 0 }, { offset: 1.5 }, { limit: Infinity }]) {
    await assert.rejects(f.session.read({ path: "a.txt", ...input }), /invalid line range/);
  }
});

test("file-tools: an edit that changes redaction across its boundary is refused before mutation", async t => {
  const f = await fixture(t, { "AB": "PRIVATE_PAIR" });
  await f.put("a.txt", "A\nB");
  await f.session.read({ path: "a.txt", limit: 1 });
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "\n", newText: "" }), /outside its observed range/);
  assert.equal(await f.get("a.txt"), "A\nB");
});

test("file-tools: writes to existing files need a full snapshot; new content is observed sanitized", async t => {
  const f = await fixture(t, { secret: "PRIVATE_VALUE" });
  await f.put("a.txt", "old");
  await assert.rejects(f.session.write({ path: "a.txt", content: "new" }), /read the existing file/);
  const result = await f.session.write({ path: "new.txt", content: "new secret" });
  assert.equal(result.text, "new PRIVATE_VALUE");
  await f.session.edit({ path: "new.txt", oldText: "new PRIVATE_VALUE", newText: "edited PRIVATE_VALUE" });
  assert.equal(await f.get("new.txt"), "edited secret");
  await assert.rejects(f.session.write({ path: "other.txt", content: "PRIVATE_VALUE" }), /not observed/);
});

test("file-tools: stale content and replaced identity are both refused", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "old");
  await f.session.read({ path: "a.txt" });
  await f.put("a.txt", "changed");
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "old", newText: "new" }), /changed since read/);
  await assert.rejects(f.session.write({ path: "a.txt", content: "new" }), /changed since read/);
  await f.session.read({ path: "a.txt" });
  await f.put("replacement.txt", "changed");
  await fs.rename(path.join(f.cwd, "replacement.txt"), path.join(f.cwd, "a.txt"));
  await assert.rejects(f.session.write({ path: "a.txt", content: "new" }), /changed since read/);
  assert.equal(await f.get("a.txt"), "changed");
});

test("file-tools: deleting an observed file does not authorize recreating it", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "old");
  await f.session.read({ path: "a.txt" });
  await fs.unlink(path.join(f.cwd, "a.txt"));
  await assert.rejects(f.session.write({ path: "a.txt", content: "new" }), /changed since read/);
  await assert.rejects(fs.stat(path.join(f.cwd, "a.txt")), { code: "ENOENT" });
});

test("file-tools: queued concurrent edits compose against the updated snapshot", async t => {
  const f = await fixture(t, { secret: "PRIVATE_VALUE" });
  await f.put("a.txt", "left secret right");
  await f.session.read({ path: "a.txt" });
  await Promise.all([
    f.session.edit({ path: "a.txt", oldText: "left", newText: "LEFT" }),
    f.session.edit({ path: "a.txt", oldText: "right", newText: "RIGHT" }),
  ]);
  assert.equal(await f.get("a.txt"), "LEFT secret RIGHT");
  const results = await Promise.allSettled([
    f.session.edit({ path: "a.txt", oldText: "LEFT", newText: "changed" }),
    f.session.edit({ path: "a.txt", oldText: "LEFT", newText: "conflict" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  // Path validation is asynchronous; the queue serializes resolved paths but
  // does not promise invocation-order scheduling for concurrent callers.
  assert.ok(["changed secret RIGHT", "conflict secret RIGHT"].includes(await f.get("a.txt")));
  assert.equal((await fs.readdir(f.cwd)).filter(name => name.startsWith(".pi-redaction-")).length, 0);
});

test("file-tools: simultaneous new-file writes cannot silently overwrite one another", async t => {
  const f = await fixture(t);
  const a = createFileSession({ cwd: f.cwd, redactor: mock() });
  const b = createFileSession({ cwd: f.cwd, redactor: mock() });
  const results = await Promise.allSettled([a.write({ path: "new.txt", content: "one" }), b.write({ path: "new.txt", content: "two" })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.ok(["one", "two"].includes(await f.get("new.txt")));
  assert.deepEqual(await fs.readdir(f.cwd), ["new.txt"]);
});

test("file-tools: workspace traversal, literal escapes, symlinks, and directory files are refused", async t => {
  const f = await fixture(t);
  const outside = await fs.mkdtemp(path.join(tmpdir(), "pi-file-tools-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "a.txt"), "outside");
  await f.put("a.txt", "inside");
  await fs.symlink(path.join(outside, "a.txt"), path.join(f.cwd, "file-link"));
  await fs.symlink(outside, path.join(f.cwd, "directory-link"));
  await fs.symlink(path.join(f.cwd, "a.txt"), path.join(f.cwd, "inside-link"));
  for (const input of [path.join(outside, "a.txt"), "../escape", "file-link", "directory-link/a.txt", "inside-link", "."]) {
    await assert.rejects(f.session.read({ path: input }), refused);
    await assert.rejects(f.session.write({ path: input, content: "x" }), refused);
  }
  const literal = createFileSession({ cwd: f.cwd, redactor: mock(), literalMappings: { [outside]: "PRIVATE_DIR" } });
  await assert.rejects(literal.read({ path: "PRIVATE_DIR/a.txt" }), /outside the allowed workspace/);
  assert.equal(await fs.readFile(path.join(outside, "a.txt"), "utf8"), "outside");
});

test("file-tools: replacing an observed file with a symlink cannot modify its target", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "one");
  await f.put("target.txt", "target");
  await f.session.read({ path: "a.txt" });
  await fs.unlink(path.join(f.cwd, "a.txt"));
  await fs.symlink(path.join(f.cwd, "target.txt"), path.join(f.cwd, "a.txt"));
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "one", newText: "x" }), /symlink/);
  assert.equal(await f.get("target.txt"), "target");
});

test("file-tools: replacing an observed parent with a symlink is refused", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.cwd, "dir"));
  await fs.mkdir(path.join(f.cwd, "other"));
  await f.put("dir/a.txt", "one");
  await f.put("other/a.txt", "one");
  await f.session.read({ path: "dir/a.txt" });
  await fs.rename(path.join(f.cwd, "dir"), path.join(f.cwd, "saved"));
  await fs.symlink(path.join(f.cwd, "other"), path.join(f.cwd, "dir"));
  await assert.rejects(f.session.write({ path: "dir/a.txt", content: "x" }), /symlink/);
  assert.equal(await f.get("other/a.txt"), "one");
});

test("file-tools: canonical cwd may be a symlink but descendants may not", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "hello");
  const alias = `${f.cwd}-alias`;
  await fs.symlink(f.cwd, alias);
  t.after(() => fs.unlink(alias));
  const session = createFileSession({ cwd: alias, redactor: mock() });
  assert.equal((await session.read({ path: "a.txt" })).path, path.join(f.cwd, "a.txt"));
});

test("file-tools: explicit protected paths reject read, write, edit, and path registration", async t => {
  const f = await fixture(t, { "private.json": "PRIVATE_CONFIG" });
  await f.put("private.json", "synthetic config");
  const session = createFileSession({ cwd: f.cwd, redactor: mock({ "private.json": "PRIVATE_CONFIG" }), literalMappings: { "private.json": "PRIVATE_CONFIG" }, protectedPaths: ["private.json"] });
  for (const input of ["private.json", "PRIVATE_CONFIG"]) {
    await assert.rejects(session.read({ path: input }), /protected/);
    await assert.rejects(session.write({ path: input, content: "x" }), /protected/);
    await assert.rejects(session.edit({ path: input, oldText: "synthetic", newText: "x" }), /protected/);
  }
  await assert.rejects(session.rememberPath("private.json"), /protected/);
  assert.equal(await f.get("private.json"), "synthetic config");
});

test("file-tools: default config protection honors a synthetic XDG_CONFIG_HOME", async t => {
  const f = await fixture(t);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = f.cwd;
  try {
    await fs.mkdir(path.join(f.cwd, "pi-redaction"));
    await f.put("pi-redaction/config.json", "synthetic config");
    const session = createFileSession({ cwd: f.cwd, redactor: mock() });
    await assert.rejects(session.read({ path: "pi-redaction/config.json" }), /protected/);
    await assert.rejects(session.write({ path: "pi-redaction/config.json", content: "x" }), /protected/);
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("file-tools: literal path collision never chooses one of two existing files", async t => {
  const f = await fixture(t, { secret: "PRIVATE_VALUE" });
  await f.put("secret.txt", "original");
  await f.put("PRIVATE_VALUE.txt", "collision");
  await assert.rejects(f.session.read({ path: "PRIVATE_VALUE.txt" }), /collides/);
  await assert.rejects(f.session.write({ path: "PRIVATE_VALUE.txt", content: "x" }), /collides/);
  assert.equal(await f.get("secret.txt"), "original");
  assert.equal(await f.get("PRIVATE_VALUE.txt"), "collision");
});

test("file-tools: path-only observation never authorizes file edits or token restoration", async t => {
  const f = await fixture(t, {}, { "a@example.test": "[EMAIL_1]" });
  await f.put("a@example.test.txt", "ordinary");
  const masked = await f.session.rememberPath("a@example.test.txt");
  await assert.rejects(f.session.edit({ path: masked, oldText: "ordinary", newText: "x" }), /read the file/);
  await f.session.read({ path: masked });
  await assert.rejects(f.session.write({ path: masked, content: "[EMAIL_1]" }), /not observed/);
});

test("file-tools: literal, generated, overlapping, and source-text alias collisions fail closed", async t => {
  const f = await fixture(t);
  const invalidLiterals: Record<string, string>[] = [{ a: "TOKEN", b: "TOKEN" }, { a: "TOKEN", b: "TOKEN_LONG" }, { TOKEN: "TOKEN" }, { a: "" }, { "": "TOKEN" }];
  for (const literals of invalidLiterals) {
    assert.throws(() => createFileSession({ cwd: f.cwd, redactor: mock(), literalMappings: literals }), refused);
  }
  await f.put("a.txt", "a@example.test b@example.test");
  const collision = createFileSession({ cwd: f.cwd, redactor: mock({}, { "a@example.test": "[EMAIL_1]", "b@example.test": "[EMAIL_1]" }) });
  await assert.rejects(collision.read({ path: "a.txt" }), /collision/);
  await f.put("a.txt", "a@example.test and [EMAIL_1]");
  await assert.rejects(createFileSession({ cwd: f.cwd, redactor: mock({}, { "a@example.test": "[EMAIL_1]" }) }).read({ path: "a.txt" }), /ambiguous alias/);
  await f.put("a.txt", "[EMAIL_88]");
  await assert.rejects(f.session.read({ path: "a.txt" }), /ambiguous alias/);
});

test("file-tools: newly discovered alias cannot reinterpret a previously observed literal", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "literal PRIVATE_VALUE");
  await f.put("b.txt", "secret");
  const session = createFileSession({ cwd: f.cwd, redactor: mock({ secret: "PRIVATE_VALUE" }) });
  await session.read({ path: "a.txt" });
  await assert.rejects(session.read({ path: "b.txt" }), /alias collision/);
  assert.equal(await f.get("a.txt"), "literal PRIVATE_VALUE");
});

test("file-tools: reset removes snapshots and generated paths and cancels pending operations", async t => {
  const f = await fixture(t, {}, { "a@example.test": "[EMAIL_1]" });
  await f.put("a@example.test.txt", "one");
  await f.session.read({ path: "a@example.test.txt" });
  const pending = f.session.write({ path: "a@example.test.txt", content: "two" });
  f.session.reset();
  await assert.rejects(pending, /session was reset/);
  await assert.rejects(f.session.read({ path: "[EMAIL_1].txt" }), /unknown masked path/);
  await assert.rejects(f.session.edit({ path: "a@example.test.txt", oldText: "one", newText: "x" }), /read the file/);
  assert.equal(await f.get("a@example.test.txt"), "one");
});

test("file-tools: failures never expose input, paths, or redactor exceptions", async t => {
  const f = await fixture(t);
  await f.put("synthetic-sensitive-name.txt", "synthetic-sensitive-content");
  const session = createFileSession({ cwd: f.cwd, redactor: { redact() { throw new Error("synthetic-sensitive-content"); }, reset() {} } });
  for (const operation of [() => session.read({ path: "synthetic-sensitive-name.txt" }), () => f.session.read({ path: "missing-sensitive-name.txt" })]) {
    await assert.rejects(operation, error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, refused);
      assert.ok(!error.message.includes("sensitive"));
      assert.ok(!error.message.includes(f.cwd));
      assert.equal(error.stack, error.message);
      return true;
    });
  }
});

test("file-tools: binary reads and invalid UTF-8/NUL/surrogate writes are refused without changes", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, "binary"), Buffer.from([0xff, 0x00]));
  await assert.rejects(f.session.read({ path: "binary" }), /UTF-8/);
  for (const content of ["a\0b", "a\uD800b"]) {
    await assert.rejects(f.session.write({ path: "new.txt", content }), /UTF-8/);
    await assert.rejects(fs.stat(path.join(f.cwd, "new.txt")), { code: "ENOENT" });
  }
});

test("file-tools: malformed native spans and rendered text are rejected", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "😀secret");
  const results: RedactionResult[] = [
    { text: "wrong", matches: [] },
    { text: "x", matches: [{ start: -1, end: 2, replacement: "X", kind: "literal" }] },
    { text: "x", matches: [{ start: 1, end: 2, replacement: "X", kind: "literal" }] },
    { text: "x", matches: [{ start: 2, end: 99, replacement: "X", kind: "literal" }] },
    { text: "x", matches: [{ start: 2, end: 8, replacement: "X", kind: "literal" }, { start: 3, end: 4, replacement: "Y", kind: "literal" }] },
  ];
  for (const result of results) {
    const session = createFileSession({ cwd: f.cwd, redactor: { redact: () => result, reset() {} } });
    await assert.rejects(session.read({ path: "a.txt" }), /invalid redaction/);
  }
});

test("file-tools: atomic writes retain permission bits and leave no temporary artifacts", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "old");
  await fs.chmod(path.join(f.cwd, "a.txt"), 0o640);
  await f.session.read({ path: "a.txt" });
  await f.session.write({ path: "a.txt", content: "new" });
  assert.equal((await fs.stat(path.join(f.cwd, "a.txt"))).mode & 0o777, 0o640);
  assert.equal(await f.get("a.txt"), "new");
  assert.deepEqual(await fs.readdir(f.cwd), ["a.txt"]);
});

test("file-tools: disjoint batch matches one original snapshot and commits once", async t => {
  const f = await fixture(t, { "secret-a": "PRIVATE_A", "secret-b": "PRIVATE_B" });
  await f.put("a.txt", "left secret-a\ncenter\nright secret-b\n");
  await f.session.read({ path: "a.txt" });
  const before = await fs.stat(path.join(f.cwd, "a.txt"));
  const result = await f.session.editMany({ path: "a.txt", edits: [
    { oldText: "right PRIVATE_B", newText: "RIGHT PRIVATE_B" },
    { oldText: "left PRIVATE_A", newText: "LEFT PRIVATE_A extra" },
  ] });
  assert.equal(result.text, "LEFT PRIVATE_A extra\ncenter\nRIGHT PRIVATE_B\n");
  assert.equal(await f.get("a.txt"), "LEFT secret-a extra\ncenter\nRIGHT secret-b\n");
  assert.notEqual((await fs.stat(path.join(f.cwd, "a.txt"))).ino, before.ino);
  assert.deepEqual(await fs.readdir(f.cwd), ["a.txt"]);
});

test("file-tools: failure in second batch edit leaves bytes and inode identical", async t => {
  const f = await fixture(t, { secret: "PRIVATE_VALUE" });
  await f.put("a.txt", "left secret right");
  await f.session.read({ path: "a.txt" });
  const before = await fs.stat(path.join(f.cwd, "a.txt"));
  for (const edits of [
    [{ oldText: "left", newText: "LEFT" }, { oldText: "missing", newText: "x" }],
    [{ oldText: "left", newText: "LEFT" }, { oldText: "right", newText: "PRIVATE_VALUE" }],
    [{ oldText: "left PRIVATE_VALUE", newText: "x" }, { oldText: "PRIVATE_VALUE right", newText: "y" }],
    [{ oldText: "left", newText: "right" }, { oldText: "right", newText: "END" }],
  ]) {
    // Last case is valid: matching the original "right" is NOT ambiguous with
    // the "right" introduced by the first replacement.
    if (edits[0].newText === "right") {
      await f.session.editMany({ path: "a.txt", edits });
      assert.equal(await f.get("a.txt"), "right secret END");
    } else {
      await assert.rejects(f.session.editMany({ path: "a.txt", edits }), refused);
      assert.equal(await f.get("a.txt"), "left secret right");
      assert.equal((await fs.stat(path.join(f.cwd, "a.txt"))).ino, before.ino);
    }
  }
});

test("file-tools: tokens in one batch range cannot be injected into another range", async t => {
  const f = await fixture(t, { secret: "PRIVATE_VALUE" });
  await f.put("a.txt", "first secret second");
  await f.session.read({ path: "a.txt" });
  await assert.rejects(f.session.editMany({ path: "a.txt", edits: [
    { oldText: "first PRIVATE_VALUE", newText: "FIRST PRIVATE_VALUE" },
    { oldText: "second", newText: "SECOND PRIVATE_VALUE" },
  ] }), /not observed/);
  assert.equal(await f.get("a.txt"), "first secret second");
  await assert.rejects(f.session.editMany({ path: "a.txt", edits: [] }), /at least one/);
});

test("file-tools: batch fails entirely if one disjoint range is outside a partial view", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "visible\nhidden\n");
  await f.session.read({ path: "a.txt", limit: 1 });
  await assert.rejects(f.session.editMany({ path: "a.txt", edits: [
    { oldText: "visible", newText: "VISIBLE" },
    { oldText: "hidden", newText: "HIDDEN" },
  ] }), /outside the observed view/);
  assert.equal(await f.get("a.txt"), "visible\nhidden\n");
});

test("file-tools: parent identity stays pinned even if the file inode is retained", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.cwd, "dir"));
  await f.put("dir/a.txt", "old");
  await f.session.read({ path: "dir/a.txt" });
  await fs.rename(path.join(f.cwd, "dir"), path.join(f.cwd, "saved"));
  await fs.mkdir(path.join(f.cwd, "dir"));
  await fs.link(path.join(f.cwd, "saved/a.txt"), path.join(f.cwd, "dir/a.txt"));
  await assert.rejects(f.session.write({ path: "dir/a.txt", content: "new" }), /parent identity changed/);
  assert.equal(await f.get("dir/a.txt"), "old");
});

test("file-tools: workspace identity stays pinned when the root is replaced", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "old");
  await f.session.read({ path: "a.txt" });
  const saved = `${f.cwd}-saved`;
  t.after(() => fs.rm(saved, { recursive: true, force: true }));
  await fs.rename(f.cwd, saved);
  await fs.mkdir(f.cwd);
  await f.put("a.txt", "replacement root");
  await assert.rejects(f.session.read({ path: "a.txt" }), /workspace identity changed/);
  await assert.rejects(f.session.write({ path: "a.txt", content: "new" }), /workspace identity changed/);
  assert.equal(await f.get("a.txt"), "replacement root");
});

test("file-tools: lexical cwd aliases cannot bypass explicit config protection", async t => {
  const f = await fixture(t);
  await f.put("config.json", "synthetic");
  await f.put("a.txt", "ordinary");
  const alias = `${f.cwd}-alias`;
  await fs.symlink(f.cwd, alias);
  t.after(() => fs.unlink(alias));
  const session = createFileSession({ cwd: alias, redactor: mock(), protectedPaths: ["config.json"] });
  await assert.rejects(session.read({ path: "config.json" }), /protected/);
  await assert.rejects(session.read({ path: path.join(alias, "config.json") }), /protected/);
  assert.equal((await session.read({ path: path.join(alias, "a.txt") })).text, "ordinary");
});

test("file-tools: path alias discovery cannot reinterpret literal file content", async t => {
  const f = await fixture(t);
  await f.put("secret.txt", "literal PRIVATE_VALUE");
  const session = createFileSession({ cwd: f.cwd, redactor: mock({ secret: "PRIVATE_VALUE" }) });
  await assert.rejects(session.read({ path: "secret.txt" }), /ambiguous alias/);
  await assert.rejects(session.write({ path: "new-secret.txt", content: "literal PRIVATE_VALUE" }), /not observed/);
  await assert.rejects(fs.stat(path.join(f.cwd, "new-secret.txt")), { code: "ENOENT" });
});

test("file-tools: recheck just before rename detects an external change after initial validation", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "old");
  let armed = false;
  let pathScans = 0;
  const plain = mock();
  const session = createFileSession({ cwd: f.cwd, redactor: {
    redact(text) {
      // Simulate an external writer during commit preflight, after the edit's
      // initial current() check. No raw/private data is involved.
      if (armed && text === path.join(f.cwd, "a.txt") && ++pathScans === 2) writeFileSync(path.join(f.cwd, "a.txt"), "raced");
      return plain.redact(text);
    },
    reset() {},
  } });
  await session.read({ path: "a.txt" });
  armed = true;
  await assert.rejects(session.edit({ path: "a.txt", oldText: "old", newText: "new" }), /changed since read/);
  assert.equal(pathScans, 2);
  assert.equal(await f.get("a.txt"), "raced");
  assert.deepEqual(await fs.readdir(f.cwd), ["a.txt"]);
});

test("file-tools: externally changed permission bits are stale rather than silently reverted", async t => {
  const f = await fixture(t);
  await f.put("a.txt", "old");
  await fs.chmod(path.join(f.cwd, "a.txt"), 0o644);
  await f.session.read({ path: "a.txt" });
  await fs.chmod(path.join(f.cwd, "a.txt"), 0o600);
  await assert.rejects(f.session.write({ path: "a.txt", content: "new" }), /changed since read/);
  assert.equal((await fs.stat(path.join(f.cwd, "a.txt"))).mode & 0o777, 0o600);
  assert.equal(await f.get("a.txt"), "old");
});

test("file-tools: generated path aliases colliding with actual files are rejected at observation", async t => {
  const f = await fixture(t, {}, { "a@example.test": "[EMAIL_1]" });
  await f.put("a@example.test.txt", "original");
  await f.put("[EMAIL_1].txt", "collision");
  await assert.rejects(f.session.rememberPath("a@example.test.txt"), /collides/);
  await assert.rejects(f.session.read({ path: "a@example.test.txt" }), /collides/);
  await assert.rejects(f.session.read({ path: "[EMAIL_1].txt" }), /unknown masked path/);
  assert.equal(await f.get("a@example.test.txt"), "original");
  assert.equal(await f.get("[EMAIL_1].txt"), "collision");
});

test("file-tools: complete literal dictionary rejects unseen aliases before any secret observation", async t => {
  const f = await fixture(t, { "unobserved-synthetic-value": "UNSEEN_PRIVATE_ALIAS" });
  await assert.rejects(f.session.write({ path: "new.txt", content: "UNSEEN_PRIVATE_ALIAS" }), /not observed/);
  await assert.rejects(fs.stat(path.join(f.cwd, "new.txt")), { code: "ENOENT" });
  await f.put("a.txt", "ordinary text");
  await f.session.read({ path: "a.txt" });
  await assert.rejects(f.session.edit({ path: "a.txt", oldText: "ordinary", newText: "UNSEEN_PRIVATE_ALIAS" }), /not observed/);
  assert.equal(await f.get("a.txt"), "ordinary text");
});

test("file-tools: reserved source tokens are ambiguous even when hidden inside another match", async t => {
  const f = await fixture(t, { "block [EMAIL_999] block": "PRIVATE_BLOCK" });
  await f.put("a.txt", "block [EMAIL_999] block");
  await assert.rejects(f.session.read({ path: "a.txt" }), /ambiguous alias/);
});

test("file-tools: overlapping alias occurrences formed at rendering boundaries are ambiguous", async t => {
  const f = await fixture(t, { secret: "MASK_MASK" });
  await f.put("a.txt", "secret_MASK");
  await assert.rejects(f.session.read({ path: "a.txt" }), /ambiguous rendered alias/);
  assert.equal(await f.get("a.txt"), "secret_MASK");
});
