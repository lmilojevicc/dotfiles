import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSession } from "../src/file-tools.ts";
import type { Redactor } from "../src/contracts.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "redaction-display-")));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let scans = 0;
  const redactor: Redactor = { reset() {}, redact(text) {
    scans++;
    const matches = Array.from(text.matchAll(/synthetic-private/g), m => ({ start: m.index, end: m.index + m[0].length, replacement: "PRIVATE_VALUE", kind: "literal" as const }));
    return { text: text.replaceAll("synthetic-private", "PRIVATE_VALUE"), matches };
  } };
  const session = createFileSession({ cwd, redactor, literalMappings: { "synthetic-private": "PRIVATE_VALUE" } });
  return { cwd, session, scans: () => scans };
}

test("file-tools-display: partial edit metadata includes only the authorized view and stable sanitized path", async t => {
  const f = await fixture(t);
  const name = join(f.cwd, "synthetic-private.txt");
  await fs.writeFile(name, "hidden head\nvisible synthetic-private\ncontext synthetic-private\nhidden tail\n");
  const read = await f.session.read({ path: "PRIVATE_VALUE.txt", offset: 2, limit: 2 });
  assert.deepEqual(read.redactionDisplay, { version: 1, operation: "read", path: read.path, firstLine: 2 });
  assert.equal(f.scans(), 3, "read presentation adds no scans");
  const edit = await f.session.editMany({ path: read.path, edits: [{ oldText: "visible PRIVATE_VALUE", newText: "updated PRIVATE_VALUE" }, { oldText: "context", newText: "unchanged" }] });
  assert.deepEqual(edit.redactionDisplay, { version: 1, operation: "edit", path: read.path, firstLine: 2,
    before: "visible PRIVATE_VALUE\ncontext PRIVATE_VALUE\n", after: "updated PRIVATE_VALUE\nunchanged PRIVATE_VALUE\n" });
  assert.doesNotMatch(JSON.stringify(edit), /synthetic-private|hidden/);
  assert.equal(await fs.readFile(name, "utf8"), "hidden head\nupdated synthetic-private\nunchanged synthetic-private\nhidden tail\n");
});

test("file-tools-display: existing write uses full observed before; new write before is empty", async t => {
  const f = await fixture(t);
  const created = await f.session.write({ path: "new.txt", content: "old synthetic-private" });
  assert.equal(created.redactionDisplay?.before, "");
  assert.equal(created.redactionDisplay?.after, "old PRIVATE_VALUE");
  assert.equal(created.redactionDisplay?.fileExistedBeforeWrite, false);
  const write = await f.session.write({ path: "new.txt", content: "new PRIVATE_VALUE" });
  assert.equal(write.redactionDisplay?.before, "old PRIVATE_VALUE");
  assert.equal(write.redactionDisplay?.after, write.text);
  assert.equal(write.redactionDisplay?.fileExistedBeforeWrite, true);
  assert.doesNotMatch(JSON.stringify(write), /synthetic-private/);
});

test("file-tools-display: exact serialized UTF8 budget, escaping, and combined line limits", async t => {
  const f = await fixture(t);
  const base = { version: 1, operation: "write", path: join(f.cwd, "bytes.txt"), firstLine: 1, fileExistedBeforeWrite: false, before: "", after: "" };
  const capacity = 262144 - Buffer.byteLength(JSON.stringify(base));
  const exact = await f.session.write({ path: "bytes.txt", content: "x".repeat(capacity) });
  assert.equal(Buffer.byteLength(JSON.stringify(exact.redactionDisplay)), 262144);
  const over = await f.session.write({ path: "extra.txt", content: "x".repeat(capacity + 1) });
  assert.equal(over.redactionDisplay?.unavailable, "budget");
  for (const [name, content] of [["utf8.txt", "é".repeat(140000)], ["escape.txt", "\t".repeat(140000)], ["lines.txt", Array(4097).fill("x").join("\n")]]) {
    const result = await f.session.write({ path: name, content });
    assert.equal(result.redactionDisplay?.unavailable, "budget");
    assert.equal(result.redactionDisplay?.before, undefined);
    assert.equal(result.redactionDisplay?.after, undefined);
    assert.equal(await fs.readFile(join(f.cwd, name), "utf8"), content);
  }
  const lines = await f.session.write({ path: "boundary.txt", content: Array(4096).fill("x").join("\n") });
  assert.equal(lines.redactionDisplay?.unavailable, undefined);
  const combined = await f.session.write({ path: "boundary.txt", content: "x" });
  assert.equal(combined.redactionDisplay?.unavailable, "budget");
});

test("file-tools-display: presentation preparation failure cannot refuse a committed write", async t => {
  const f = await fixture(t);
  const original = JSON.stringify;
  JSON.stringify = (() => { throw new Error("SYNTHETIC_DISPLAY_FAILURE"); }) as typeof JSON.stringify;
  let result;
  try { result = await f.session.write({ path: "committed.txt", content: "synthetic-private" }); }
  finally { JSON.stringify = original; }
  assert.equal(result.redactionDisplay, undefined);
  assert.equal(result.text, "PRIVATE_VALUE");
  assert.equal(await fs.readFile(join(f.cwd, "committed.txt"), "utf8"), "synthetic-private");
  await f.session.edit({ path: "committed.txt", oldText: "PRIVATE_VALUE", newText: "PRIVATE_VALUE!" });
});
