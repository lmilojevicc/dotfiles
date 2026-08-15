import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandCodeAuthError, readCommandCodeApiKey } from "../src/auth.ts";

const uid = process.getuid?.();

test("auth reader accepts only a protected non-empty API key file", { skip: uid === undefined }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "command-code-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authPath = join(directory, "auth.json");

  await writeFile(authPath, JSON.stringify({ apiKey: "test-key" }), { mode: 0o600 });
  assert.equal(await readCommandCodeApiKey(authPath, uid), "test-key");

  await chmod(authPath, 0o644);
  await assert.rejects(readCommandCodeApiKey(authPath, uid), CommandCodeAuthError);

  await chmod(authPath, 0o600);
  await writeFile(authPath, JSON.stringify({ apiKey: "   " }), { mode: 0o600 });
  await assert.rejects(readCommandCodeApiKey(authPath, uid), CommandCodeAuthError);
});

test("auth reader refuses symlinks without exposing their contents", { skip: uid === undefined }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "command-code-auth-link-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "target.json");
  const link = join(directory, "auth.json");
  await writeFile(target, JSON.stringify({ apiKey: "secret-that-must-not-leak" }), { mode: 0o600 });
  await symlink(target, link);

  await assert.rejects(
    readCommandCodeApiKey(link, uid),
    (error: unknown) => error instanceof CommandCodeAuthError && !error.message.includes("secret-that-must-not-leak"),
  );
});
