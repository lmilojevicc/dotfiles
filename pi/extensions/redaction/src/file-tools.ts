import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { FileEditManyInput, FileResult, FileSession, FileSessionOptions, RedactionDisplay, RedactionResult } from "./contracts.ts";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RENDERED_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOTS = 32;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PATHS = 512;
const MAX_PATH_BYTES = 1024 * 1024;
const MAX_ALIASES = 4096;
const MAX_ALIAS_BYTES = 8 * 1024 * 1024;
const MAX_SPANS = 32768;
const MAX_DISPLAY_BYTES = 256 * 1024;
const MAX_DISPLAY_LINES = 4096;

// Presentation is best-effort, bounded before mutation, and never scans or reads files.
function displayMetadata(base: RedactionDisplay, before?: string, after?: string,
  beforeRange: [number, number] = [0, before?.length ?? 0],
  afterRange: [number, number] = [0, after?.length ?? 0]): RedactionDisplay | undefined {
  try {
    const bounded = (data: RedactionDisplay) => Buffer.byteLength(JSON.stringify(data), "utf8") <= MAX_DISPLAY_BYTES ? data : undefined;
    if (before === undefined || after === undefined) return bounded(base);
    const budget = () => bounded({ ...base, unavailable: "budget" });
    // UTF-8/JSON cannot be smaller than this UTF-16 length bound. Check before copying slices.
    if (beforeRange[1] - beforeRange[0] + afterRange[1] - afterRange[0] > MAX_DISPLAY_BYTES) return budget();
    const a = before.slice(...beforeRange);
    const b = after.slice(...afterRange);
    let lines = 0;
    for (const text of [a, b]) {
      if (text.length) lines++;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") lines++;
        if (lines > MAX_DISPLAY_LINES) return budget();
      }
    }
    return bounded({ ...base, before: a, after: b }) ?? budget();
  } catch { return undefined; }
}
function firstLine(text: string, end: number): number {
  let line = 1;
  for (let i = 0; i < end; i++) if (text[i] === "\n") line++;
  return line;
}
// Account UTF-16 strings plus conservative per-entry metadata, not process RSS.
const entryBytes = (key: string, value: string): number => 2 * (key.length + value.length) + 128;
const opaqueToken = /\[[A-Z][A-Z0-9_]*_\d+\]/g;
function fail(message: string): never {
  const error = new Error(`Redaction file operation refused: ${message}`);
  // Loader paths in ordinary JS stacks can themselves contain private literals.
  error.stack = error.message;
  throw error;
}
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
interface Identity { dev: number; ino: number }
const same = (a: Identity, b: Identity): boolean => a.dev === b.dev && a.ino === b.ino;
interface Location { file: string; parents: { file: string; identity: Identity }[] }
interface Original { raw: string; digest: string; identity: Identity; mode: number }
interface Span { start: number; end: number; renderedStart: number; renderedEnd: number; alias: string; raw: string }
interface Snapshot extends Original { text: string; spans: Span[]; visible: [number, number][]; parents: Location["parents"] }

/**
 * Text-only workspace adapter. Offsets/limits are 1-based lines and a positive
 * line count. Redaction precedes slicing. Only returned ranges authorize edits;
 * whole-file writes require a full read. Results from edit/write return only
 * the updated observed view. literalMappings MUST contain the complete literal
 * dictionary; omission is valid only for a literal-free Redactor. Reserved
 * [UPPERCASE_KIND_N] tokens and source text containing aliases are refused.
 * Files/writes are capped at 8 MiB, rendered text at 16 MiB and 32768 spans.
 * Snapshots use LRU eviction at 32 files/64 MiB accounted storage: an evicted
 * file needs a fresh read before edit/write. Path spellings (512/1 MiB) and
 * aliases (4096/8 MiB) are NEVER evicted/reused; capacity refuses the prospective
 * operation, leaving existing scopes usable. Reset clears all retained state.
 * Accounting includes UTF-16 strings and estimated metadata, not a heap/RSS cap.
 * All symlinks beneath the canonical cwd are refused. Queues serialize this
 * session, not other processes: rename is
 * atomic but is NOT an OS-level compare-and-swap against external writers.
 */
export function createFileSession(options: FileSessionOptions): FileSession {
  const lexicalRoot = path.resolve(options.cwd);
  const workspacePromise = fs.realpath(lexicalRoot).then(async root => {
    const identity = await fs.lstat(root);
    if (!identity.isDirectory() || identity.isSymbolicLink()) fail("workspace unavailable");
    return { root, identity };
  }).catch(() => fail("workspace unavailable"));
  const rootPromise = workspacePromise.then(workspace => workspace.root);
  void rootPromise.catch(() => {});
  const configHome = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  const protectedPathsPromise = Promise.all(
    [path.join(configHome, "pi-redaction", "config.json"), ...(options.protectedPaths ?? [])]
      .map(async p => {
        const absolute = path.resolve(lexicalRoot, p);
        // Canonicalize existing parent directories, not private file contents.
        let parent = path.dirname(absolute);
        let suffix = path.basename(absolute);
        for (;;) {
          try { return path.join(await fs.realpath(parent), suffix); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path.dirname(parent)) fail("protected path unavailable");
            suffix = path.join(path.basename(parent), suffix);
            parent = path.dirname(parent);
          }
        }
      }),
  );
  // Creation may precede the first operation; avoid an unhandled initialization rejection.
  void protectedPathsPromise.catch(() => {});
  const literals = Object.entries(options.literalMappings ?? {});
  const aliases = new Map<string, string>();
  const knownPaths = new Map<string, string>();
  const snapshots = new Map<string, Snapshot>();
  const snapshotSizes = new Map<string, number>();
  const reservations = new Map<string, { bytes: number }>();
  let aliasBytes = 0;
  let pathBytes = 0;
  const queues = new Map<string, Promise<unknown>>();
  let generation = 0;

  function register(alias: string, raw: string): void {
    if (typeof alias !== "string" || typeof raw !== "string" || !alias || !raw || alias.includes("\0") || raw.includes(alias)) fail("ambiguous redaction alias");
    const previous = aliases.get(alias);
    if (previous !== undefined) {
      if (previous !== raw) fail("alias collision");
      return;
    }
    const bytes = entryBytes(alias, raw);
    if (aliases.size >= MAX_ALIASES || aliasBytes + bytes > MAX_ALIAS_BYTES) fail("alias capacity reached; reset the session to observe new aliases");
    const ownedAlias = Buffer.from(alias, "utf8").toString("utf8");
    const ownedRaw = Buffer.from(raw, "utf8").toString("utf8");
    if (ownedAlias !== alias || ownedRaw !== raw) fail("ambiguous redaction alias");
    for (const [other, value] of aliases) {
      if (other.includes(alias) || alias.includes(other) || raw.includes(other) || value.includes(alias)) {
        fail("ambiguous redaction alias");
      }
    }
    for (const snapshot of snapshots.values()) if (snapshot.raw.includes(alias)) fail("alias collision");
    for (const original of knownPaths.values()) if (original.includes(alias)) fail("path alias collision");
    // Detach slices: a tiny identity must not pin an evicted whole-file backing string.
    aliases.set(ownedAlias, ownedRaw);
    aliasBytes += bytes;
  }
  for (const [raw, alias] of literals) register(alias, raw);

  function checkGeneration(expected: number): void {
    if (expected !== generation) fail("session was reset; read again");
  }
  function snapshotBytes(file: string, raw: string, rendered: { text: string; spans: Span[] }, parents: Location["parents"]): number {
    return 1024 + 2 * (file.length + raw.length + rendered.text.length) +
      rendered.spans.reduce((bytes, span) => bytes + 160 + 2 * (span.raw.length + span.alias.length), 0) +
      parents.reduce((bytes, parent) => bytes + 512 + 2 * parent.file.length, 0);
  }
  function reserveSnapshot(file: string, bytes: number): { bytes: number } {
    if (bytes > MAX_SNAPSHOT_BYTES) fail("file snapshot exceeds session capacity");
    const projected = new Map(snapshotSizes);
    for (const [target, reservation] of reservations) projected.set(target, Math.max(projected.get(target) ?? 0, reservation.bytes));
    projected.set(file, Math.max(projected.get(file) ?? 0, bytes));
    let total = [...projected.values()].reduce((a, b) => a + b, 0);
    const victims: string[] = [];
    for (const [target] of snapshots) {
      if (projected.size <= MAX_SNAPSHOTS && total <= MAX_SNAPSHOT_BYTES) break;
      if (target === file || reservations.has(target)) continue;
      total -= projected.get(target)!;
      projected.delete(target);
      victims.push(target);
    }
    if (projected.size > MAX_SNAPSHOTS || total > MAX_SNAPSHOT_BYTES) fail("snapshot capacity busy; retry after pending file operations");
    // Plan before eviction so a refused reservation does not discard scopes.
    for (const target of victims) {
      snapshots.delete(target);
      snapshotSizes.delete(target);
    }
    const reservation = { bytes };
    reservations.set(file, reservation);
    return reservation;
  }
  function publishSnapshot(file: string, snapshot: Snapshot, reservation: { bytes: number }): void {
    snapshots.delete(file);
    snapshots.set(file, snapshot);
    snapshotSizes.set(file, reservation.bytes);
  }
  function touchSnapshot(file: string): Snapshot | undefined {
    const snapshot = snapshots.get(file);
    if (snapshot) {
      snapshots.delete(file);
      snapshots.set(file, snapshot);
    }
    return snapshot;
  }
  function checkSnapshot(file: string, snapshot: Snapshot): void {
    if (snapshots.get(file) !== snapshot) fail("file observation was evicted; read the file again");
  }
  function isProtected(file: string, protectedPaths: readonly string[]): boolean {
    return protectedPaths.some(p => file === p || inside(p, file));
  }
  async function locate(file: string, allowMissing: boolean): Promise<Location> {
    const root = await rootPromise;
    const protectedPaths = await protectedPathsPromise;
    if (!inside(root, file) || file === root || isProtected(file, protectedPaths)) fail("path is outside the allowed workspace or protected");
    const parents: Location["parents"] = [];
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !same(rootStat, (await workspacePromise).identity)) fail("workspace identity changed");
    parents.push({ file: root, identity: rootStat });
    let current = root;
    const segments = path.relative(root, file).split(path.sep);
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) {
        if (i === segments.length - 1 && allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") break;
        fail("file or parent unavailable");
      }
      if (stat.isSymbolicLink()) fail("symlink paths are not supported");
      if (i < segments.length - 1) {
        if (!stat.isDirectory()) fail("parent is not a directory");
        parents.push({ file: current, identity: stat });
      } else if (!stat.isFile()) fail("only regular text files are supported");
    }
    // No symlinks were followed; canonical and lexical names must still agree.
    const parent = await fs.realpath(path.dirname(file));
    if (parent !== path.dirname(file) || !inside(root, parent) || isProtected(path.join(parent, path.basename(file)), protectedPaths)) {
      fail("path identity changed");
    }
    return { file, parents };
  }
  async function validateParents(location: Location): Promise<void> {
    for (const parent of location.parents) {
      const stat = await fs.lstat(parent.file);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, parent.identity)) fail("parent identity changed");
    }
  }
  function containsAlias(text: string): boolean {
    return [...aliases.keys()].some(alias => text.includes(alias)) || [...text.matchAll(opaqueToken)].length > 0;
  }
  function literalPath(input: string): string {
    let result = "";
    for (let i = 0; i < input.length;) {
      const found = literals.find(([, alias]) => input.startsWith(alias, i));
      if (found) { result += found[0]; i += found[1].length; }
      else result += input[i++];
    }
    return result;
  }
  async function resolve(input: string, allowMissing = false, trusted = false): Promise<Location> {
    if (typeof input !== "string" || !input || input.includes("\0")) fail("invalid path");
    const root = await rootPromise;
    // Relative paths are anchored to the canonical workspace, never to process.cwd().
    const rooted = (value: string): string => {
      const lexical = path.resolve(root, value);
      return inside(lexicalRoot, lexical) ? path.resolve(root, path.relative(lexicalRoot, lexical)) : lexical;
    };
    const direct = rooted(input);
    let file = direct;
    if (!trusted) {
      const known = knownPaths.get(input) ?? knownPaths.get(direct);
      const expanded = literalPath(input);
      if (known) file = known;
      else if (expanded !== input) file = rooted(expanded);
      else if (containsAlias(input)) fail("unknown masked path; first observe the original path with a trusted local tool");
      if (file !== direct && inside(root, direct)) {
        try { await fs.lstat(direct); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return locate(file, allowMissing);
          fail("path unavailable");
        }
        fail("masked path collides with an existing path");
      }
    } else if (containsAlias(input)) fail("ambiguous trusted path");
    return locate(file, allowMissing);
  }
  function render(raw: string): { text: string; spans: Span[] } {
    if (Buffer.byteLength(raw, "utf8") > MAX_FILE_BYTES) fail("file exceeds 8 MiB limit");
    if (raw.includes("\0") || Buffer.from(raw, "utf8").toString("utf8") !== raw) fail("only UTF-8 text files are supported");
    if ([...aliases.keys()].some(alias => raw.includes(alias)) || [...raw.matchAll(opaqueToken)].length) fail("source contains ambiguous alias text");
    let result: RedactionResult;
    try { result = options.redactor.redact(raw); } catch { fail("redaction failed"); }
    if (!result || typeof result.text !== "string" || !Array.isArray(result.matches)) fail("invalid redaction result");
    if (Buffer.byteLength(result.text, "utf8") > MAX_RENDERED_BYTES || result.matches.length > MAX_SPANS) fail("rendered file exceeds capacity");
    let end = 0;
    let rendered = "";
    const spans: Span[] = [];
    const renderedAliases = new Map<string, Set<number>>();
    for (const match of result.matches) {
      if (!match || !Number.isInteger(match.start) || !Number.isInteger(match.end) || match.start < end ||
          match.end <= match.start || match.end > raw.length || typeof match.replacement !== "string" || !match.replacement ||
          splitsSurrogate(raw, match.start) || splitsSurrogate(raw, match.end)) {
        fail("invalid redaction spans");
      }
      rendered += raw.slice(end, match.start);
      const original = raw.slice(match.start, match.end);
      register(match.replacement, original);
      const renderedStart = rendered.length;
      rendered += match.replacement;
      spans.push({ start: match.start, end: match.end, renderedStart, renderedEnd: rendered.length, alias: match.replacement, raw: original });
      const positions = renderedAliases.get(match.replacement) ?? new Set<number>();
      positions.add(renderedStart);
      renderedAliases.set(match.replacement, positions);
      end = match.end;
    }
    rendered += raw.slice(end);
    if (rendered !== result.text) fail("invalid redaction rendering");
    for (const alias of aliases.keys()) {
      if (raw.includes(alias)) fail("source contains ambiguous alias text");
      for (let at = rendered.indexOf(alias); at !== -1; at = rendered.indexOf(alias, at + 1)) {
        if (!renderedAliases.get(alias)?.has(at)) fail("ambiguous rendered alias");
      }
    }
    // Reserved generated tokens must never be treated as ordinary source text.
    for (const token of rendered.matchAll(opaqueToken)) {
      if (!renderedAliases.get(token[0])?.has(token.index)) fail("unknown opaque alias");
    }
    return { text: rendered, spans };
  }
  async function rememberRelative(file: string, expected: number): Promise<string> {
    const root = await rootPromise;
    checkGeneration(expected);
    const result = render(file).text;
    const relative = render(path.relative(root, file)).text;
    for (const masked of new Set([result, relative])) {
      const prior = knownPaths.get(masked);
      if (prior && prior !== file) fail("path alias collision");
      const direct = path.resolve(root, masked);
      if (direct !== file && inside(root, direct)) {
        try { await fs.lstat(direct); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          fail("path unavailable");
        }
        fail("masked path collides with an existing path");
      }
    }
    checkGeneration(expected);
    const additions = [...new Set([result, relative])].filter(masked => !knownPaths.has(masked));
    const bytes = additions.reduce((sum, masked) => sum + entryBytes(masked, file), 0);
    if (knownPaths.size + additions.length > MAX_PATHS || pathBytes + bytes > MAX_PATH_BYTES) fail("path capacity reached; reset the session to observe new paths");
    for (const masked of additions) knownPaths.set(masked, file);
    pathBytes += bytes;
    return result;
  }
  async function load(location: Location): Promise<Original> {
    if (typeof constants.O_NOFOLLOW !== "number") fail("platform lacks safe file-open support");
    await validateParents(location);
    const handle = await fs.open(location.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) fail("only regular text files are supported");
      // Descriptor stat precedes allocation. Never trust a path stat or line limit.
      if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_FILE_BYTES) fail("file exceeds 8 MiB limit");
      const bytes = Buffer.allocUnsafe(before.size);
      let consumed = 0;
      while (consumed < bytes.length) {
        const { bytesRead } = await handle.read(bytes, consumed, Math.min(64 * 1024, bytes.length - consumed), consumed);
        if (!bytesRead) break;
        consumed += bytesRead;
      }
      // At most stat.size + 1 bytes are read, even if a file grows without bound.
      // Any growth/shrink refuses the whole file; no unscanned prefix is returned.
      const probe = Buffer.allocUnsafe(1);
      const extra = await handle.read(probe, 0, 1, consumed);
      if (consumed !== before.size || extra.bytesRead !== 0) fail("file changed during read");
      const after = await handle.stat();
      const named = await fs.lstat(location.file);
      if (named.isSymbolicLink() || !same(before, named) || !same(before, after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        fail("file changed during read");
      }
      await validateParents(location);
      const raw = bytes.toString("utf8");
      if (raw.includes("\0") || !Buffer.from(raw, "utf8").equals(bytes)) fail("only UTF-8 text files are supported");
      return { raw, digest: hash(bytes), identity: before, mode: before.mode };
    } finally { await handle.close(); }
  }
  async function current(location: Location, snapshot: Snapshot): Promise<void> {
    await validateParents({ file: location.file, parents: snapshot.parents });
    const original = await load(location);
    if (!same(original.identity, snapshot.identity) || original.digest !== snapshot.digest || original.mode !== snapshot.mode) fail("file changed since read; read again");
  }
  function queue<T>(file: string, expected: number, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(file) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => { checkGeneration(expected); return operation(); });
    queues.set(file, next);
    void next.finally(() => { if (queues.get(file) === next) queues.delete(file); }).catch(() => {});
    return next;
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch (error) {
      if (error instanceof Error && error.message.startsWith("Redaction file operation refused:")) throw error;
      fail("filesystem operation failed");
    }
  }
  function bounds(text: string, offset = 1, limit?: number): [number, number] {
    if (!Number.isSafeInteger(offset) || offset < 1 || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))) fail("invalid line range");
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
    const start = starts[offset - 1] ?? text.length;
    const end = limit === undefined ? text.length : (starts[offset - 1 + limit] ?? text.length);
    return [start, end];
  }
  function splitsSurrogate(text: string, position: number): boolean {
    return position > 0 && position < text.length && /[\uD800-\uDBFF]/.test(text[position - 1]) && /[\uDC00-\uDFFF]/.test(text[position]);
  }
  function renderedOffset(spans: Span[], position: number): number {
    let delta = 0;
    for (const span of spans) {
      if (position > span.start && position < span.end) fail("edit changes redaction outside its observed range");
      if (position >= span.end) delta += span.alias.length - span.raw.length;
    }
    return position + delta;
  }
  function rawOffset(snapshot: Snapshot, position: number): number {
    let delta = 0;
    for (const span of snapshot.spans) {
      if (position > span.renderedStart && position < span.renderedEnd) fail("partial-token edit");
      if (position >= span.renderedEnd) delta += span.raw.length - span.alias.length;
    }
    return position + delta;
  }
  function restore(text: string, allowed: Span[]): string {
    if (Buffer.byteLength(text, "utf8") > MAX_RENDERED_BYTES) fail("replacement exceeds capacity");
    const scope = new Map(allowed.map(s => [s.alias, s.raw]));
    const knownAliases = [...aliases.keys()];
    for (const token of text.matchAll(opaqueToken)) if (!aliases.has(token[0])) fail("unknown opaque alias");
    const parts: string[] = [];
    let restoredBytes = 0;
    function append(value: string): void {
      restoredBytes += Buffer.byteLength(value, "utf8");
      if (restoredBytes > MAX_FILE_BYTES) fail("file exceeds 8 MiB limit");
      if (value) parts.push(value);
    }
    for (let cursor = 0; cursor < text.length;) {
      let start = text.length;
      let alias: string | undefined;
      for (const candidate of knownAliases) {
        const found = text.indexOf(candidate, cursor);
        if (found !== -1 && found < start) { start = found; alias = candidate; }
      }
      append(text.slice(cursor, start));
      if (!alias) break;
      const end = start + alias.length;
      for (const candidate of knownAliases) {
        const found = text.indexOf(candidate, start + 1);
        if (found !== -1 && found < end) fail("ambiguous replacement alias");
      }
      const raw = scope.get(alias);
      if (raw === undefined) fail("alias was not observed in the edited range");
      append(raw);
      cursor = end;
    }
    return parts.join("");
  }
  async function commit(location: Location, raw: string, snapshot: Snapshot | undefined, expected: number, candidate?: { text: string; spans: Span[] }, visible?: [number, number]): Promise<{ original: Original; rendered: { text: string; spans: Span[] }; resultPath: string }> {
    // Validate content and model-facing path before any mutation.
    if (typeof constants.O_NOFOLLOW !== "number") fail("platform lacks safe file-open support");
    const resultPath = await rememberRelative(location.file, expected);
    checkGeneration(expected);
    const rendered = candidate ?? render(raw);
    checkGeneration(expected);
    if (snapshot) checkSnapshot(location.file, snapshot);
    const reservation = reserveSnapshot(location.file, snapshotBytes(location.file, raw, rendered, location.parents));
    const temporary = path.join(path.dirname(location.file), `.pi-redaction-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let created = false;
    try {
      await validateParents(location);
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      await handle.writeFile(raw, "utf8");
      if (snapshot) await handle.chmod(snapshot.mode & 0o777);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await validateParents(location);
      if (snapshot) await current(location, snapshot);
      checkGeneration(expected);
      if (snapshot) await fs.rename(temporary, location.file);
      else {
        // link is atomic exclusive creation, unlike rename which could overwrite a raced-in file.
        await fs.link(temporary, location.file);
        await fs.unlink(temporary);
      }
      created = false;
      const original = await load(location);
      if (original.raw !== raw) fail("file changed after write; read again");
      checkGeneration(expected);
      publishSnapshot(location.file, { ...original, ...rendered, visible: [visible ?? [0, rendered.text.length]], parents: location.parents }, reservation);
      return { original, rendered, resultPath };
    } finally {
      if (reservations.get(location.file) === reservation) reservations.delete(location.file);
      await handle?.close();
      if (created) await fs.unlink(temporary).catch(() => {});
    }
  }

  function applyEdits(input: FileEditManyInput): Promise<FileResult> {
    return guarded(async () => {
      const expected = generation;
      const location = await resolve(input.path);
      return queue(location.file, expected, async () => {
        const checked = await locate(location.file, false);
        const snapshot = touchSnapshot(location.file);
        if (!snapshot) fail("read the file before editing");
        if (!Array.isArray(input.edits) || !input.edits.length) fail("at least one edit is required");
        const displayPath = await rememberRelative(location.file, expected);
        checkGeneration(expected);
        const edits = input.edits.map(edit => {
          if (!edit || typeof edit.oldText !== "string" || !edit.oldText || typeof edit.newText !== "string") fail("invalid edit text");
          const start = snapshot.text.indexOf(edit.oldText);
          if (start < 0 || snapshot.text.indexOf(edit.oldText, start + 1) !== -1) fail("old text must match exactly once");
          const end = start + edit.oldText.length;
          if (!snapshot.visible.some(([a, b]) => start >= a && end <= b)) fail("edit is outside the observed view");
          const rawStart = rawOffset(snapshot, start);
          const rawEnd = rawOffset(snapshot, end);
          const allowed = snapshot.spans.filter(s => s.renderedStart >= start && s.renderedEnd <= end);
          return { start, end, rawStart, rawEnd, replacement: restore(edit.newText, allowed) };
        }).sort((a, b) => a.start - b.start);
        for (let i = 1; i < edits.length; i++) if (edits[i].start < edits[i - 1].end) fail("edit ranges overlap");
        checkSnapshot(location.file, snapshot);
        const nextBytes = Buffer.byteLength(snapshot.raw, "utf8") + edits.reduce((bytes, edit) =>
          bytes + Buffer.byteLength(edit.replacement, "utf8") - Buffer.byteLength(snapshot.raw.slice(edit.rawStart, edit.rawEnd), "utf8"), 0);
        if (nextBytes > MAX_FILE_BYTES) fail("file exceeds 8 MiB limit");
        let raw = "";
        let cursor = 0;
        for (const edit of edits) {
          raw += snapshot.raw.slice(cursor, edit.rawStart) + edit.replacement;
          cursor = edit.rawEnd;
        }
        raw += snapshot.raw.slice(cursor);
        const candidate = render(raw);
        let rawDelta = 0;
        let oldCursor = 0;
        let newCursor = 0;
        for (const edit of edits) {
          const candidateStart = renderedOffset(candidate.spans, edit.rawStart + rawDelta);
          const candidateEnd = renderedOffset(candidate.spans, edit.rawStart + rawDelta + edit.replacement.length);
          if (candidate.text.slice(newCursor, candidateStart) !== snapshot.text.slice(oldCursor, edit.start)) fail("edit changes redaction outside its observed range");
          oldCursor = edit.end;
          newCursor = candidateEnd;
          rawDelta += edit.replacement.length - (edit.rawEnd - edit.rawStart);
        }
        if (candidate.text.slice(newCursor) !== snapshot.text.slice(oldCursor)) fail("edit changes redaction outside its observed range");
        await current(checked, snapshot);
        const oldVisible = snapshot.visible[0];
        const delta = candidate.text.length - snapshot.text.length;
        const visible: [number, number] = [oldVisible[0], oldVisible[1] + delta];
        const redactionDisplay = displayMetadata({ version: 1, operation: "edit", path: displayPath,
          firstLine: firstLine(snapshot.text, oldVisible[0]) }, snapshot.text, candidate.text, oldVisible, visible);
        const { rendered, resultPath } = await commit(checked, raw, snapshot, expected, candidate, visible);
        return { text: rendered.text.slice(...visible), path: resultPath, redactionDisplay };
      });
    });
  }

  return {
    read(input) {
      return guarded(async () => {
        const expected = generation;
        const location = await resolve(input.path);
        return queue(location.file, expected, async () => {
          const checked = await locate(location.file, false);
          const original = await load(checked);
          const resultPath = await rememberRelative(location.file, expected);
          checkGeneration(expected);
          const rendered = render(original.raw);
          const visible = bounds(rendered.text, input.offset, input.limit);
          checkGeneration(expected);
          // Each read grants only its own returned view, not the hidden full snapshot.
          const reservation = reserveSnapshot(location.file, snapshotBytes(location.file, original.raw, rendered, checked.parents));
          publishSnapshot(location.file, { ...original, ...rendered, visible: [visible], parents: checked.parents }, reservation);
          reservations.delete(location.file);
          return { text: rendered.text.slice(...visible), path: resultPath,
            redactionDisplay: displayMetadata({ version: 1, operation: "read", path: resultPath, firstLine: input.offset ?? 1 }) };
        });
      });
    },
    rememberPath(input) {
      return guarded(async () => {
        const expected = generation;
        const location = await resolve(input, false, true);
        return queue(location.file, expected, async () => {
          await locate(location.file, false);
          const result = await rememberRelative(location.file, expected);
          checkGeneration(expected);
          return result;
        });
      });
    },
    edit(input) {
      return applyEdits({ path: input.path, edits: [{ oldText: input.oldText, newText: input.newText }] });
    },
    editMany: applyEdits,
    write(input) {
      return guarded(async () => {
        const expected = generation;
        const location = await resolve(input.path, true);
        return queue(location.file, expected, async () => {
          const checked = await locate(location.file, true);
          const snapshot = touchSnapshot(location.file);
          if (typeof input.content !== "string") fail("invalid file content");
          let exists = true;
          try { await fs.lstat(location.file); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            exists = false;
          }
          if (exists && !snapshot) fail("read the existing file before overwriting");
          if (!exists && snapshot) fail("file changed since read; read again");
          if (snapshot && !snapshot.visible.some(([a, b]) => a === 0 && b === snapshot.text.length)) fail("whole-file write requires a full read");
          const displayPath = await rememberRelative(location.file, expected);
          checkGeneration(expected);
          const raw = restore(input.content, snapshot?.spans ?? []);
          if (snapshot) await current(checked, snapshot);
          const candidate = render(raw);
          const redactionDisplay = displayMetadata({ version: 1, operation: "write", path: displayPath,
            firstLine: 1, fileExistedBeforeWrite: exists }, snapshot?.text ?? "", candidate.text);
          const { rendered, resultPath } = await commit(checked, raw, snapshot, expected, candidate);
          return { text: rendered.text, path: resultPath, redactionDisplay };
        });
      });
    },
    reset() {
      generation++;
      snapshots.clear();
      snapshotSizes.clear();
      reservations.clear();
      knownPaths.clear();
      aliases.clear();
      aliasBytes = 0;
      pathBytes = 0;
      for (const [raw, alias] of literals) register(alias, raw);
      try { options.redactor.reset(); } catch { fail("redactor reset failed"); }
    },
  };
}
