import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { offConfig, parseConfigJson, privateConfigPath, validateConfig } from "./config.ts";
import type { ExtensionConfig } from "./contracts.ts";
import type { ConfigStoreErrorCode, PrivateConfigSnapshot, PrivateConfigStore } from "./menu-contracts.ts";

const LIMIT = 1024 * 1024;
const MAX_MISSING_DIRECTORIES = 16;
const revisionKey = randomBytes(32);
const queues = new Map<string, Promise<void>>();

/** Deliberately carries no path, configuration, original error, or cause. */
export class ConfigStoreError extends Error {
  readonly code: ConfigStoreErrorCode;
  constructor(code: ConfigStoreErrorCode) {
    const safeCode = (["invalid", "unsafe", "conflict", "busy", "io"] as const).find(value => value === code) ?? "io";
    super(`Private configuration ${safeCode}.`);
    this.name = "ConfigStoreError";
    this.code = safeCode;
  }
}
function fail(code: ConfigStoreErrorCode): never { throw new ConfigStoreError(code); }
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function safeError(error: unknown): ConfigStoreError {
  if (error instanceof ConfigStoreError) return new ConfigStoreError(error.code);
  return new ConfigStoreError(["ELOOP", "ENOTDIR", "EACCES", "EPERM"].includes(errno(error) ?? "") ? "unsafe" : "io");
}
function uid(): bigint {
  if (process.platform === "win32" || !process.getuid || !constants.O_NOFOLLOW) fail("unsafe");
  return BigInt(process.getuid());
}
function identity(info: BigIntStats): string {
  return [info.dev, info.ino, info.uid, info.gid, info.mode].join(":");
}
function fileIdentity(info: BigIntStats): string {
  // Rename/link change ctime and nlink, but not these facts. The content hash is also bound.
  return `${identity(info)}:${info.size}:${info.mtimeNs}`;
}
function sameRead(a: BigIntStats, b: BigIntStats): boolean {
  return fileIdentity(a) === fileIdentity(b) && a.ctimeNs === b.ctimeNs && a.nlink === b.nlink;
}
function directorySafe(info: BigIntStats, immediate: boolean): void {
  const owner = uid();
  if (!info.isDirectory() || info.isSymbolicLink()) fail("unsafe");
  if (immediate ? info.uid !== owner : info.uid !== owner && info.uid !== 0n) fail("unsafe");
  // Only root-owned sticky temp ancestors may be writable. Never use them as a creation anchor.
  if ((info.mode & 0o022n) !== 0n && (immediate || info.uid !== 0n || (info.mode & 0o1000n) === 0n)) fail("unsafe");
}
function fileSafe(info: BigIntStats): void {
  if (!info.isFile() || info.uid !== uid() || (info.mode & 0o077n) !== 0n || (info.mode & 0o7000n) !== 0n) fail("unsafe");
  if (info.size > BigInt(LIMIT)) fail("invalid");
}
type Directory = { path: string; identity: string };
type State = { directories: Directory[]; missing: string[]; file: { identity: string; hash: string } | null };
type Reading = { state: State; config: ExtensionConfig };
function revision(path: string, state: State): string {
  return createHmac("sha256", revisionKey).update(path).update(JSON.stringify(state)).digest("hex");
}
async function maybeStat(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (errno(error) === "ENOENT") return undefined; throw error; }
}
async function parents(path: string): Promise<Pick<State, "directories" | "missing">> {
  const parent = dirname(path);
  const root = parse(parent).root;
  const components = parent.slice(root.length).split("/").filter(Boolean);
  const paths = [root];
  for (const component of components) paths.push(join(paths.at(-1)!, component));
  const directories: Directory[] = [];
  const missing: string[] = [];
  for (const [index, item] of paths.entries()) {
    const info = missing.length ? undefined : await maybeStat(item);
    if (!info) { missing.push(item); continue; }
    directorySafe(info, index === paths.length - 1);
    directories.push({ path: item, identity: identity(info) });
  }
  if (missing.length) {
    if (missing.length > MAX_MISSING_DIRECTORIES) fail("unsafe");
    const anchor = await lstat(directories.at(-1)!.path, { bigint: true });
    directorySafe(anchor, true);
    if (identity(anchor) !== directories.at(-1)!.identity) fail("conflict");
  }
  return { directories, missing };
}
function sameParents(a: Pick<State, "directories" | "missing">, b: Pick<State, "directories" | "missing">): boolean {
  return JSON.stringify([a.directories, a.missing]) === JSON.stringify([b.directories, b.missing]);
}
async function readState(path: string): Promise<Reading> {
  const before = await parents(path);
  if (before.missing.length) return { state: { ...before, file: null }, config: offConfig() };
  const info = await maybeStat(path);
  if (!info) return { state: { ...before, file: null }, config: offConfig() };
  fileSafe(info);
  let handle: FileHandle | undefined;
  try {
    // NONBLOCK prevents a raced-in FIFO from hanging before fstat can reject it.
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    fileSafe(opened);
    if (!sameRead(info, opened)) fail("conflict");
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      // One sentinel byte detects growth; never issue an unbounded readFile.
      const chunk = Buffer.alloc(Math.min(64 * 1024, LIMIT + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > LIMIT) fail("invalid");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    fileSafe(after);
    const current = await maybeStat(path);
    if (!current || !sameRead(opened, after) || !sameRead(after, current) || !sameParents(before, await parents(path))) fail("conflict");
    const bytes = Buffer.concat(chunks, length);
    let config: ExtensionConfig;
    try { config = parseConfigJson(bytes.toString("utf8")); } catch { fail("invalid"); }
    return { config, state: { ...before, file: { identity: fileIdentity(after), hash: createHash("sha256").update(bytes).digest("hex") } } };
  } finally { await handle?.close(); }
}
async function serialized<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>(done => { release = done; });
  queues.set(path, next);
  await previous;
  try { return await operation(); }
  finally { release(); if (queues.get(path) === next) queues.delete(path); }
}
type OwnedEntry = { path: string; identity: string };
async function removeOwned(entry: OwnedEntry, directory = false): Promise<void> {
  const info = await maybeStat(entry.path);
  if (!info) return;
  if (identity(info) !== entry.identity) fail("conflict");
  if (directory) await rmdir(entry.path); else await unlink(entry.path);
}
async function exclusiveFile(path: string): Promise<{ handle: FileHandle; entry: OwnedEntry }> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600); // Only the newly exclusively created inode is changed.
    const info = await handle.stat({ bigint: true });
    fileSafe(info);
    return { handle, entry: { path, identity: identity(info) } };
  } catch (error) {
    // Creation succeeded even if later fd operations failed. Only remove that inode.
    try {
      const info = await handle.stat({ bigint: true });
      await removeOwned({ path, identity: identity(info) });
    } catch { /* Retain entries whose ownership/identity cannot be verified. */ }
    await handle.close().catch(() => {});
    throw error;
  }
}

/** POSIX only. Symlink path components are unsupported, including symlinked XDG paths.
 * Missing directory creation refuses a umask that removes owner access; existing paths are untouched.
 * Cooperative locking and identity checks are not OS-level CAS against hostile same-user mutation.
 */
export function createPrivateConfigStore(path = privateConfigPath()): PrivateConfigStore {
  const absolute = resolve(path);
  const validPath = isAbsolute(path) && basename(absolute) !== "." && absolute !== parse(absolute).root;
  function checkPath(): void { if (!validPath) fail("unsafe"); uid(); }
  function snapshot(reading: Reading): PrivateConfigSnapshot {
    return { path: absolute, config: reading.config, revision: revision(absolute, reading.state) };
  }
  return {
    async read() {
      try { checkPath(); return snapshot(await readState(absolute)); }
      catch (error) { throw safeError(error); }
    },
    async save(expected, draft) {
      return serialized(absolute, async () => {
        const createdDirectories: OwnedEntry[] = [];
        let lock: Awaited<ReturnType<typeof exclusiveFile>> | undefined;
        let temporary: Awaited<ReturnType<typeof exclusiveFile>> | undefined;
        let directoryHandle: FileHandle | undefined;
        let committed: PrivateConfigSnapshot | undefined;
        let failure: unknown;
        const warnings: Array<"durability" | "cleanup"> = [];
        try {
          checkPath();
          let config: ExtensionConfig;
          let bytes: Buffer;
          try {
            config = validateConfig(draft);
            const json = JSON.stringify(config) + "\n";
            if (Buffer.byteLength(json) > LIMIT) fail("invalid");
            // Ensure serialization itself obeys the unchanged parser (e.g. exotic input objects).
            config = parseConfigJson(json);
            bytes = Buffer.from(json);
          } catch { fail("invalid"); }
          if (!expected || expected.path !== absolute || typeof expected.revision !== "string") fail("conflict");
          const initial = await readState(absolute);
          if (revision(absolute, initial.state) !== expected.revision) fail("conflict");
          // Do not change the global umask or chmod directory pathnames to recover owner access.
          if (initial.state.missing.length && (process.umask() & 0o700) !== 0) fail("unsafe");
          let intended: State = { ...initial.state, directories: [...initial.state.directories], missing: [...initial.state.missing] };
          for (const item of initial.state.missing) {
            if (!sameParents(intended, await parents(absolute))) fail("conflict");
            try { await mkdir(item, { mode: 0o700 }); }
            catch (error) { if (errno(error) === "EEXIST") fail("conflict"); throw error; }
            const newDirectory = await open(item, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
            let info: BigIntStats;
            try {
              info = await newDirectory.stat({ bigint: true });
              directorySafe(info, true);
              const entry = { path: item, identity: identity(info) };
              createdDirectories.push(entry);
              await newDirectory.chmod(0o700); // Never chmod pre-existing ancestors.
              info = await newDirectory.stat({ bigint: true });
              entry.identity = identity(info);
            } finally { await newDirectory.close(); }
            const entry = { path: item, identity: identity(info) };
            intended = { ...intended, directories: [...intended.directories, entry], missing: intended.missing.slice(1) };
          }
          if (!sameParents(intended, await parents(absolute))) fail("conflict");
          try { lock = await exclusiveFile(join(dirname(absolute), `.${basename(absolute)}.lock`)); }
          catch (error) { if (errno(error) === "EEXIST") fail("busy"); throw error; }
          const verify = async () => {
            const current = await readState(absolute);
            if (revision(absolute, current.state) !== revision(absolute, intended)) fail("conflict");
            const lockInfo = await maybeStat(lock!.entry.path);
            if (!lockInfo || identity(lockInfo) !== lock!.entry.identity) fail("conflict");
          };
          await verify();
          directoryHandle = await open(dirname(absolute), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
          const directoryInfo = await directoryHandle.stat({ bigint: true });
          if (identity(directoryInfo) !== intended.directories.at(-1)!.identity) fail("conflict");
          await directoryHandle.sync();
          temporary = await exclusiveFile(join(dirname(absolute), `.${basename(absolute)}.${randomUUID()}.tmp`));
          await temporary.handle.writeFile(bytes);
          await temporary.handle.sync();
          const tempInfo = await temporary.handle.stat({ bigint: true });
          fileSafe(tempInfo);
          if (tempInfo.size !== BigInt(bytes.length)) fail("io");
          await temporary.handle.close();
          await verify();
          const tempPathInfo = await maybeStat(temporary.entry.path);
          if (!tempPathInfo || !sameRead(tempInfo, tempPathInfo)) fail("conflict");
          const saved = snapshot({ config, state: { ...intended, file: { identity: fileIdentity(tempInfo), hash: createHash("sha256").update(bytes).digest("hex") } } });
          // Commit point: after this succeeds, never report that the save was unapplied.
          if (intended.file) await rename(temporary.entry.path, absolute);
          else {
            try { await link(temporary.entry.path, absolute); }
            catch (error) { if (errno(error) === "EEXIST") fail("conflict"); throw error; }
          }
          committed = saved;
          try { await directoryHandle.sync(); } catch { warnings.push("durability"); }
        } catch (error) { failure = error; }
        finally {
          for (const handle of [temporary?.handle, lock?.handle, directoryHandle]) {
            try { await handle?.close(); } catch { if (committed && !warnings.includes("cleanup")) warnings.push("cleanup"); }
          }
          for (const entry of [temporary?.entry, lock?.entry]) {
            if (!entry) continue;
            try { await removeOwned(entry); } catch { if (committed && !warnings.includes("cleanup")) warnings.push("cleanup"); }
          }
          if (!committed) {
            for (const entry of createdDirectories.reverse()) {
              try { await removeOwned(entry, true); } catch { /* Never remove nonempty/replaced directories. */ }
            }
          }
        }
        if (committed) return warnings.length ? { ...committed, warnings } : committed;
        throw safeError(failure);
      });
    },
  };
}
