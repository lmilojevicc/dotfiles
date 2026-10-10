import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { truncateSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createFileSession } from "../src/file-tools.ts";
import type { Redactor, RedactionResult } from "../src/contracts.ts";

const MiB = 1024 * 1024;
const plain = (): Redactor => ({ redact: text => ({ text, matches: [] }), reset() {} });
function exact(source: string, alias: string): Redactor {
  return {
    redact(text) {
      const matches: RedactionResult["matches"] = [];
      const parts: string[] = [];
      let cursor = 0;
      for (let start = text.indexOf(source); start !== -1; start = text.indexOf(source, cursor)) {
        parts.push(text.slice(cursor, start), alias);
        matches.push({ start, end: start + source.length, replacement: alias, kind: "literal" });
        cursor = start + source.length;
      }
      parts.push(text.slice(cursor));
      return { text: parts.join(""), matches };
    },
    reset() {},
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "pi-file-bounds-")));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const put = (name: string, content = "") => fs.writeFile(path.join(cwd, name), content);
  return { cwd, put };
}

test("file-tools bounded-read: oversized sparse descriptor refuses before reads, allocation or scan even with limit=1", async t => {
  const { cwd, put } = await fixture(t);
  await put("large.txt", "synthetic\n");
  truncateSync(path.join(cwd, "large.txt"), 256 * MiB);
  const sample = await fs.open(path.join(cwd, "large.txt"), "r");
  const prototype = Object.getPrototypeOf(sample);
  await sample.close();
  let reads = 0;
  let scans = 0;
  let largeAllocations = 0;
  t.mock.method(prototype, "read", () => { reads++; throw new Error("unexpected read"); });
  t.mock.method(prototype, "readFile", () => { reads++; throw new Error("unexpected unbounded read"); });
  const allocate = Buffer.allocUnsafe;
  t.mock.method(Buffer, "allocUnsafe", (size: number) => {
    if (size >= 8 * MiB) { largeAllocations++; throw new Error("unexpected full-file allocation"); }
    return allocate(size);
  });
  const session = createFileSession({ cwd, redactor: { redact(text) { scans++; return { text, matches: [] }; }, reset() {} } });
  await assert.rejects(session.read({ path: "large.txt", limit: 1 }), /file exceeds 8 MiB limit/);
  assert.equal(reads, 0);
  assert.equal(largeAllocations, 0);
  assert.equal(scans, 0);
  assert.equal((await fs.stat(path.join(cwd, "large.txt"))).size, 256 * MiB);
});

test("file-tools bounded-read: growth after descriptor stat reads only initial size plus one, never scans a prefix", async t => {
  const { cwd, put } = await fixture(t);
  const file = path.join(cwd, "growing.txt");
  await put("growing.txt", "small");
  const sample = await fs.open(file, "r");
  const prototype = Object.getPrototypeOf(sample);
  const originalRead = sample.read as (this: typeof sample, buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
  await sample.close();
  let bytesRead = 0;
  let calls = 0;
  let scans = 0;
  t.mock.method(prototype, "read", async function(this: typeof sample, buffer: Buffer, offset: number, length: number, position: number) {
    if (calls++ === 0) truncateSync(file, 256 * MiB);
    const result = await originalRead.call(this, buffer, offset, length, position);
    bytesRead += result.bytesRead;
    return result;
  });
  const session = createFileSession({ cwd, redactor: { redact(text) { scans++; return { text, matches: [] }; }, reset() {} } });
  await assert.rejects(session.read({ path: "growing.txt", limit: 1 }), /file changed during read/);
  assert.equal(bytesRead, 6);
  assert.equal(calls, 2);
  assert.equal(scans, 0);
});

test("file-tools bounded-read: short descriptor reads are completed, exactly 8 MiB accepted without truncation", async t => {
  const { cwd, put } = await fixture(t);
  const content = "x".repeat(8 * MiB - 1) + "\n";
  await put("boundary.txt", content);
  let scanned = 0;
  const session = createFileSession({ cwd, redactor: {
    redact(text) { if (text === content) scanned++; return { text, matches: [] }; }, reset() {},
  } });
  const result = await session.read({ path: "boundary.txt", limit: 1 });
  assert.equal(result.text, content);
  assert.equal(scanned, 1);
  await put("boundary.txt", content + "x");
  await assert.rejects(session.read({ path: "boundary.txt", limit: 1 }), /8 MiB/);
});

test("file-tools bounded-read: partial OS reads and UTF-8 split at chunk boundary remain complete", async t => {
  const { cwd, put } = await fixture(t);
  const content = "a".repeat(64 * 1024 - 1) + "😀é\nend";
  await put("unicode.txt", content);
  const sample = await fs.open(path.join(cwd, "unicode.txt"), "r");
  const prototype = Object.getPrototypeOf(sample);
  const originalRead = sample.read as (this: typeof sample, buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
  await sample.close();
  t.mock.method(prototype, "read", async function(this: typeof sample, buffer: Buffer, offset: number, length: number, position: number) {
    return originalRead.call(this, buffer, offset, Math.min(length, 997), position);
  });
  const session = createFileSession({ cwd, redactor: plain() });
  assert.equal((await session.read({ path: "unicode.txt" })).text, content);
});

test("file-tools snapshot count: LRU eviction invalidates writes/edits, re-read recovers and aliases never change", async t => {
  const { cwd, put } = await fixture(t);
  const source = "synthetic-secret";
  const alias = "PRIVATE_VALUE";
  const session = createFileSession({ cwd, redactor: exact(source, alias), literalMappings: { [source]: alias } });
  for (let i = 0; i < 32; i++) {
    await put(`${i}.txt`, `${source} marker-${i}`);
    await session.read({ path: `${i}.txt` });
  }
  // Refresh file 0, so file 1 (not file 0) becomes the oldest scope.
  await session.read({ path: "0.txt" });
  await put("32.txt", source);
  await session.read({ path: "32.txt" });
  await assert.rejects(session.edit({ path: "1.txt", oldText: `${alias} marker-1`, newText: alias }), /read the file/);
  await assert.rejects(session.write({ path: "1.txt", content: alias }), /read the existing file/);
  await session.edit({ path: "0.txt", oldText: `${alias} marker-0`, newText: `${alias} still-observed` });
  assert.equal((await session.read({ path: "1.txt" })).text, `${alias} marker-1`);
  await session.edit({ path: "1.txt", oldText: `${alias} marker-1`, newText: `${alias} recovered` });
  assert.equal(await fs.readFile(path.join(cwd, "1.txt"), "utf8"), `${source} recovered`);
});

test("file-tools snapshot byte budget: 64 MiB accounted storage evicts before count limit", async t => {
  const { cwd, put } = await fixture(t);
  const session = createFileSession({ cwd, redactor: plain() });
  const content = "x".repeat(6 * MiB);
  for (let i = 0; i < 3; i++) {
    await put(`${i}.txt`, content);
    await session.read({ path: `${i}.txt`, limit: 1 });
  }
  // Raw+rendered UTF-16 strings alone account 24 MiB per file; three exceed 64.
  await assert.rejects(session.write({ path: "0.txt", content: "replacement" }), /read the existing file/);
  await session.write({ path: "2.txt", content: "still authorized" });
  await session.read({ path: "0.txt" });
  await session.write({ path: "0.txt", content: "recovered" });
  assert.equal(await fs.readFile(path.join(cwd, "0.txt"), "utf8"), "recovered");
});

test("file-tools capacity-before-write: oversized individual snapshot never creates or changes files", async t => {
  const { cwd, put } = await fixture(t);
  const source = "source-secret";
  const alias = "BEGIN_" + "x".repeat(MiB - 10) + "_END";
  assert.equal(alias.length, MiB);
  const session = createFileSession({ cwd, redactor: exact(source, alias), literalMappings: { [source]: alias } });
  await put("existing.txt", "ordinary");
  await session.read({ path: "existing.txt" });
  const content = source.repeat(16); // 16 MiB output plus repeated span strings exceeds 64 MiB accounting.
  await assert.rejects(session.write({ path: "new.txt", content }), /snapshot exceeds session capacity/);
  await assert.rejects(fs.stat(path.join(cwd, "new.txt")), { code: "ENOENT" });
  await assert.rejects(session.write({ path: "existing.txt", content }), /snapshot exceeds session capacity/);
  assert.equal(await fs.readFile(path.join(cwd, "existing.txt"), "utf8"), "ordinary");
  assert.deepEqual(await fs.readdir(cwd), ["existing.txt"]);
  await session.edit({ path: "existing.txt", oldText: "ordinary", newText: "still usable" });
});

test("file-tools capacity-before-write: >8 MiB writes and edit expansion refuse before disk mutation", async t => {
  const { cwd, put } = await fixture(t);
  const session = createFileSession({ cwd, redactor: plain() });
  await put("existing.txt", "old");
  await session.read({ path: "existing.txt" });
  const tooLarge = "x".repeat(8 * MiB + 1);
  await assert.rejects(session.write({ path: "new.txt", content: tooLarge }), /8 MiB/);
  await assert.rejects(session.edit({ path: "existing.txt", oldText: "old", newText: tooLarge }), /8 MiB/);
  assert.deepEqual(await fs.readdir(cwd), ["existing.txt"]);
  assert.equal(await fs.readFile(path.join(cwd, "existing.txt"), "utf8"), "old");
});

test("file-tools path count: 512 spellings refuse only novel paths, existing scopes and reset work", async t => {
  const { cwd, put } = await fixture(t);
  const session = createFileSession({ cwd, redactor: plain() });
  await put("0.txt", "old");
  await session.read({ path: "0.txt" });
  for (let i = 1; i < 256; i++) {
    await put(`${i}.txt`);
    await session.rememberPath(`${i}.txt`);
  }
  await assert.rejects(session.write({ path: "new.txt", content: "new" }), /path capacity reached/);
  await assert.rejects(fs.stat(path.join(cwd, "new.txt")), { code: "ENOENT" });
  await session.edit({ path: "0.txt", oldText: "old", newText: "existing usable" });
  session.reset();
  await session.write({ path: "new.txt", content: "after reset" });
  assert.equal(await fs.readFile(path.join(cwd, "new.txt"), "utf8"), "after reset");
});

test("file-tools path byte budget: long spellings reach 1 MiB below count limit", async t => {
  const { cwd } = await fixture(t);
  const directory = Array.from({ length: 6 }, (_, i) => `${i}-${"d".repeat(118)}`).join(path.sep);
  await fs.mkdir(path.join(cwd, directory), { recursive: true });
  const session = createFileSession({ cwd, redactor: plain() });
  let remembered = 0;
  for (let i = 0; i < 256; i++) {
    const relative = path.join(directory, `${i}-${"f".repeat(96)}.txt`);
    await fs.writeFile(path.join(cwd, relative), "ordinary");
    try { await session.rememberPath(relative); remembered++; }
    catch (error) { assert.match((error as Error).message, /path capacity reached/); break; }
  }
  assert.ok(remembered > 0 && remembered < 256);
  const first = path.join(directory, `0-${"f".repeat(96)}.txt`);
  assert.equal((await session.read({ path: first })).text, "ordinary");
});

test("file-tools alias count: 4096 identities refuse a new alias but retain existing authorization", async t => {
  const { cwd, put } = await fixture(t);
  const literals = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`source-${String(i).padStart(5, "0")}-end`, `LIT_${String(i).padStart(5, "0")}_MASK`]));
  const automatic = exact("new-synthetic-secret", "[EMAIL_1]");
  const session = createFileSession({ cwd, redactor: automatic, literalMappings: literals });
  await put("existing.txt", "old");
  await session.read({ path: "existing.txt" });
  await assert.rejects(session.write({ path: "new.txt", content: "new-synthetic-secret" }), /alias capacity reached/);
  await assert.rejects(fs.stat(path.join(cwd, "new.txt")), { code: "ENOENT" });
  await session.edit({ path: "existing.txt", oldText: "old", newText: "existing usable" });
  assert.equal(await fs.readFile(path.join(cwd, "existing.txt"), "utf8"), "existing usable");
});

test("file-tools alias byte budget: large original identity refuses only that operation", async t => {
  const { cwd, put } = await fixture(t);
  const source = "s".repeat(5 * MiB);
  const session = createFileSession({ cwd, redactor: exact(source, "[PRIVATE_KEY_1]") });
  await put("existing.txt", "old");
  await session.read({ path: "existing.txt" });
  await assert.rejects(session.write({ path: "new.txt", content: source }), /alias capacity reached/);
  await assert.rejects(fs.stat(path.join(cwd, "new.txt")), { code: "ENOENT" });
  await session.edit({ path: "existing.txt", oldText: "old", newText: "existing usable" });
});

test("file-tools rendered and span budgets refuse before creating files", async t => {
  const { cwd } = await fixture(t);
  const alias = "BEGIN_" + "x".repeat(MiB - 10) + "_END";
  const expanded = createFileSession({ cwd, redactor: exact("source-secret", alias), literalMappings: { "source-secret": alias } });
  await assert.rejects(expanded.write({ path: "output.txt", content: "source-secret".repeat(17) }), /rendered file exceeds capacity/);
  const spans = createFileSession({ cwd, redactor: exact("s", "[EMAIL_1]") });
  await assert.rejects(spans.write({ path: "a.txt", content: "s".repeat(32769) }), /rendered file exceeds capacity/);
  assert.deepEqual(await fs.readdir(cwd), []);
});

test("file-tools eviction: an in-flight edit loses authorization if its scope is evicted before reservation", async t => {
  const { cwd, put } = await fixture(t);
  const session = createFileSession({ cwd, redactor: plain() });
  await put("victim.txt", "old");
  await session.read({ path: "victim.txt" });
  for (let i = 0; i < 32; i++) await put(`${i}.txt`, "ordinary");
  const sample = await fs.open(path.join(cwd, "victim.txt"), "r");
  const prototype = Object.getPrototypeOf(sample);
  const originalRead = sample.read as (this: typeof sample, buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Buffer }>;
  await sample.close();
  let signal!: () => void;
  let resume!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let armed = true;
  t.mock.method(prototype, "read", async function(this: typeof sample, buffer: Buffer, offset: number, length: number, position: number) {
    if (armed) { armed = false; signal(); await gate; }
    return originalRead.call(this, buffer, offset, length, position);
  });
  const editing = session.edit({ path: "victim.txt", oldText: "old", newText: "new" });
  const rejection = assert.rejects(editing, /observation was evicted/);
  await started;
  try {
    for (let i = 0; i < 32; i++) await session.read({ path: `${i}.txt` });
  } finally { resume(); }
  await rejection;
  assert.equal(await fs.readFile(path.join(cwd, "victim.txt"), "utf8"), "old");
  await session.read({ path: "victim.txt" });
  await session.edit({ path: "victim.txt", oldText: "old", newText: "recovered" });
});

test("file-tools reservation: a committing snapshot stays pinned while other reads evict LRU scopes", async t => {
  const { cwd, put } = await fixture(t);
  const session = createFileSession({ cwd, redactor: plain() });
  await put("pinned.txt", "old");
  await session.read({ path: "pinned.txt" });
  for (let i = 0; i < 32; i++) await put(`${i}.txt`, "ordinary");
  const sample = await fs.open(path.join(cwd, "pinned.txt"), "r");
  const prototype = Object.getPrototypeOf(sample);
  const originalSync = sample.sync;
  await sample.close();
  let signal!: () => void;
  let resume!: () => void;
  const started = new Promise<void>(resolve => { signal = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let armed = true;
  t.mock.method(prototype, "sync", async function(this: typeof sample) {
    if (armed) { armed = false; signal(); await gate; }
    return originalSync.call(this);
  });
  const writing = session.write({ path: "pinned.txt", content: "new" });
  await started;
  try {
    for (let i = 0; i < 32; i++) await session.read({ path: `${i}.txt` });
  } finally { resume(); }
  await writing;
  await session.edit({ path: "pinned.txt", oldText: "new", newText: "still authorized" });
  assert.equal(await fs.readFile(path.join(cwd, "pinned.txt"), "utf8"), "still authorized");
  assert.equal((await fs.readdir(cwd)).filter(name => name.startsWith(".pi-redaction-")).length, 0);
});
