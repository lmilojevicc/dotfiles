import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const COMMAND_CODE_AUTH_PATH = join(homedir(), ".commandcode", "auth.json");
const MAX_AUTH_BYTES = 64 * 1024;
const AUTH_HELP =
  "Command Code credentials are unavailable. Run `cmd login`, then ensure ~/.commandcode/auth.json is owned by your user and has mode 0600.";

export class CommandCodeAuthError extends Error {
  constructor() {
    super(AUTH_HELP);
    this.name = "CommandCodeAuthError";
  }
}

export async function readCommandCodeApiKey(
  path = COMMAND_CODE_AUTH_PATH,
  expectedUid = process.getuid?.(),
): Promise<string> {
  if (expectedUid === undefined) throw new CommandCodeAuthError();

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o7777) !== 0o600) {
      throw new CommandCodeAuthError();
    }
    if (stat.size <= 0 || stat.size > MAX_AUTH_BYTES) throw new CommandCodeAuthError();

    // Read at most the validated size plus one byte. FileHandle.readFile() can
    // allocate without bound if another process grows the file after stat().
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.uid !== stat.uid ||
      after.mode !== stat.mode ||
      after.ino !== stat.ino ||
      after.dev !== stat.dev ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    ) {
      throw new CommandCodeAuthError();
    }

    const parsed: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      typeof (parsed as { apiKey?: unknown }).apiKey !== "string" ||
      !(parsed as { apiKey: string }).apiKey.trim()
    ) {
      throw new CommandCodeAuthError();
    }
    return (parsed as { apiKey: string }).apiKey;
  } catch (error) {
    if (error instanceof CommandCodeAuthError) throw error;
    throw new CommandCodeAuthError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
