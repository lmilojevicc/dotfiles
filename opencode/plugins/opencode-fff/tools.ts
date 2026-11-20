/**
 * FFF search tools, independent of OpenCode so they can be tested directly.
 *
 * Ported from @ff-labs/pi-fff 0.11.0 (MIT): the same query building, smart-case and regex
 * auto-detection, fuzzy fallback, frecency/git annotations, weak-match trimming and cursor
 * pagination. Pi-only parts (TUI rendering, @-mention autocomplete, modes) and the multi-pattern
 * grep are left out.
 */
import nodePath from "node:path";
import type { FileFinderApi, GrepCursor, GrepMode, GrepResult } from "@ff-labs/fff-bun";
import { AuxFinderPool, routePathConstraint } from "./fff/aux-finders.ts";
import { HOME_DIR, isFsRoot, isHomeDir, resolveDbPaths } from "./fff/paths.ts";
import { FilePickerFactory } from "./fff/picker.ts";
import { buildQuery, normalizeExcludes, normalizePathConstraint } from "./fff/query.ts";

export const DEFAULT_GREP_LIMIT = 20;
export const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 50;
// Must stay decoupled from pageSize: grep cursors advance by file offset (pi-fff #825).
const GREP_MAX_MATCHES_PER_FILE = 200;
export const GREP_CONTEXT_MAX = 20;
const GREP_MAX_LINE_LENGTH = 500;
const GREP_TIME_BUDGET_MS = 10_000;
const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;
const FIND_WEAK_SAMPLE_SIZE = 5;
/**
 * fffind fetches the ranked list once and pages through that snapshot. Native `fileSearch` paging
 * is not usable: its `pageIndex` is an item offset, and fuzzy ties reorder between calls.
 */
const FIND_SNAPSHOT_MAX = 5_000;
/** Listings (glob, no ranking) are cheap to hold, so they may be much larger. */
const LIST_SNAPSHOT_MAX = 100_000;

export interface GrepParams {
  pattern: string;
  path?: string;
  exclude?: string | string[];
  caseSensitive?: boolean;
  /** Treat the pattern as exact text even when it looks like a regex. */
  literal?: boolean;
  context?: number;
  limit?: number;
  cursor?: string;
}

export interface FindParams {
  pattern: string;
  path?: string;
  exclude?: string | string[];
  limit?: number;
  cursor?: string;
}

export interface ToolOutput {
  text: string;
  metadata: Record<string, unknown>;
}

interface FindEntry {
  path: string;
  note: string;
}

interface FindCursor {
  entries: FindEntry[];
  pageSize: number;
  offset: number;
  /** Matches beyond the snapshot that were never fetched. */
  unfetched: number;
}

/** Bounded map of opaque cursor ids, so the model never sees native cursor objects. */
class CursorStore<T> {
  private readonly entries = new Map<string, T>();
  private counter = 0;
  constructor(
    private readonly prefix: string,
    private readonly max = 200,
  ) {}
  store(value: T): string {
    const id = `${this.prefix}${++this.counter}`;
    this.entries.set(id, value);
    if (this.entries.size > this.max) {
      const first = this.entries.keys().next().value;
      if (first) this.entries.delete(first);
    }
    return id;
  }
  get(id: string): T | undefined {
    return this.entries.get(id);
  }
}

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

export function clampContext(context: number | undefined): number {
  if (!context || context < 0) return 0;
  return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

/** At most one tag: git-dirty beats frecency. */
export function fileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown") return `  [${git} in git]`;
  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";
  return "";
}

/** Grouped by file in native (frecency) order; never re-sorted. */
export function formatGrepOutput(result: GrepResult): string {
  if (result.items.length === 0) return "No matches found";
  const lines: string[] = [];
  let currentFile = "";
  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fileAnnotation(match)}`);
    }
    match.contextBefore?.forEach((line: string, i: number) => {
      lines.push(` ${match.lineNumber - match.contextBefore!.length + i}- ${truncateLine(line)}`);
    });
    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);
    match.contextAfter?.forEach((line: string, i: number) => {
      lines.push(` ${match.lineNumber + 1 + i}- ${truncateLine(line)}`);
    });
  }
  return lines.join("\n");
}

/** A perfect fuzzy match scores about len × 12; under half of that is scattered noise. */
function weakScoreThreshold(pattern: string): number {
  return Math.floor((pattern.length * 12 * 50) / 100);
}

/** An empty or wildcard-only fffind pattern means "list", not a fuzzy query. */
export function isListingPattern(pattern: string | undefined): boolean {
  return /^(?:|\*|\*\*|\*\*\/\*|\.|\.\/)$/.test((pattern ?? "").trim());
}

/** The glob that lists what a normalized path constraint names: `src/` → `src/**`. */
export function constraintGlob(constraint: string): string {
  if (constraint.endsWith("/")) return `${constraint}**`;
  if (/[*?[{]/.test(constraint)) return constraint;
  return constraint.includes("/") ? constraint : `**/${constraint}`;
}

/** Applies normalized `!exclude` constraints to repo-relative paths (glob listings take no query). */
export function excludeFilter(excludes: string[]): (path: string) => boolean {
  const tests = excludes.map((raw) => {
    const c = raw.replace(/^!/, "");
    if (c.endsWith("/")) return (p: string) => p.startsWith(c) || p.includes(`/${c}`);
    if (/[*?[{]/.test(c)) {
      const direct = new Bun.Glob(c);
      const nested = new Bun.Glob(`**/${c}`);
      return (p: string) => direct.match(p) || nested.match(p);
    }
    return (p: string) => p === c || p.endsWith(`/${c}`);
  });
  return (path) => !tests.some((test) => test(path));
}

function hasRegexSyntax(pattern: string): boolean {
  return pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex only when the pattern has metacharacters and actually parses. */
export function grepMode(pattern: string): GrepMode {
  if (!hasRegexSyntax(pattern)) return "plain";
  try {
    new RegExp(pattern);
    return "regex";
  } catch {
    return "plain";
  }
}

/** `.*` and friends: the model trying to read a whole file through grep. */
export function isWildcardOnly(pattern: string): boolean {
  return (
    hasRegexSyntax(pattern) &&
    /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(pattern.trim())
  );
}

export interface FffToolsOptions {
  /** Workspace root the main picker indexes. */
  cwd: string;
  frecencyDbPath?: string;
  historyDbPath?: string;
  /** Index $HOME when OpenCode runs from it (pi-fff default: true). */
  enableHomeDirScanning?: boolean;
  enableFsRootScanning?: boolean;
  followSymlinks?: boolean;
  onWarning?: (message: string) => void;
}

/** The workspace picker, a pool of pickers for paths outside it, and the three tools. */
export function createFffTools(options: FffToolsOptions) {
  const cwd = nodePath.resolve(options.cwd);
  const dbs = resolveDbPaths({ frecency: options.frecencyDbPath, history: options.historyDbPath });
  const pickers = new FilePickerFactory({
    frecencyDbPath: dbs.frecency,
    historyDbPath: dbs.history,
    onDbFailure: (error) =>
      options.onWarning?.(`FFF frecency/history databases unavailable, searching without them: ${error}`),
  });
  const enableHomeDirScanning = options.enableHomeDirScanning ?? true;
  const enableFsRootScanning = options.enableFsRootScanning ?? false;
  const followSymlinks = options.followSymlinks ?? true;
  const pool = new AuxFinderPool({
    enableFsRootScanning,
    enableHomeDirScanning,
    followSymlinks,
    pickers,
    onHomeDirScan: (root) => options.onWarning?.(`FFF is indexing ${root}, which covers your home directory.`),
  });
  const grepCursors = new CursorStore<{ cursor: GrepCursor; mode: GrepMode }>("fff_c");
  // Snapshots hold up to FIND_SNAPSHOT_MAX paths each, so keep fewer of them.
  const findCursors = new CursorStore<FindCursor>("", 20);

  let main: Promise<FileFinderApi> | undefined;
  function mainFinder(): Promise<FileFinderApi> {
    if (isFsRoot(cwd) && !enableFsRootScanning) {
      return Promise.reject(new Error("FFF does not index the filesystem root; open OpenCode in a project."));
    }
    if (isHomeDir(cwd) && !enableHomeDirScanning) {
      return Promise.reject(new Error(`FFF home directory indexing is disabled (${HOME_DIR}).`));
    }
    main ??= pickers
      .create({ basePath: cwd, enableHomeDirScanning, enableFsRootScanning, followSymlinks })
      .catch((error) => {
        main = undefined;
        throw error;
      });
    return main;
  }

  /** A path outside the workspace gets its own picker; the query is rebased onto that picker's root. */
  async function auxFor(pathParam: string | undefined, pattern: string, exclude: string | string[] | undefined) {
    const route = routePathConstraint(pathParam, cwd);
    if (!route) return null;
    const aux = await pool.acquire(route.root);
    const rebase = nodePath.relative(aux.root, route.root).replaceAll(nodePath.sep, "/");
    const suffix = [rebase, route.suffix].filter(Boolean).join("/");
    return {
      finder: aux.finder,
      query: buildQuery(suffix || undefined, pattern, exclude, aux.root),
      root: aux.root,
      /** The path constraint relative to the picker's root. */
      path: suffix || undefined,
    };
  }

  /** Directory a `path` outside the workspace would index, or undefined for workspace paths. */
  function externalRoot(pathParam: string | undefined): string | undefined {
    return routePathConstraint(pathParam, cwd)?.root;
  }

  async function grep(params: GrepParams): Promise<ToolOutput> {
    const pattern = params.pattern;
    const literal = params.literal === true;
    if (!literal && isWildcardOnly(pattern)) {
      return {
        text: `Pattern '${pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
        metadata: { totalMatched: 0, totalFiles: 0 },
      };
    }
    const aux = await auxFor(params.path, pattern, params.exclude);
    const picker = aux ? aux.finder : await mainFinder();
    const pageSize = Math.min(Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT), GREP_PAGE_SIZE_MAX);
    const context = clampContext(params.context);
    const query = aux ? aux.query : buildQuery(params.path, pattern, params.exclude, cwd);
    const resumed = params.cursor ? grepCursors.get(params.cursor) : undefined;
    if (params.cursor && !resumed) throw new Error(`Unknown or expired cursor "${params.cursor}"; run the search again.`);
    let mode: GrepMode = resumed?.mode ?? (literal ? "plain" : grepMode(pattern));
    const smartCase = params.caseSensitive !== true;
    const base = {
      smartCase,
      maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
      pageSize,
      classifyDefinitions: true,
      timeBudgetMs: GREP_TIME_BUDGET_MS,
    };

    const first = picker.grep(query, {
      ...base,
      mode,
      cursor: resumed?.cursor ?? null,
      beforeContext: context,
      afterContext: context,
    });
    if (!first.ok) throw new Error(first.error);
    let result = first.value;

    // A regex that finds nothing is often literal code that happens to parse ("weird-[brackets]",
    // "foo(bar)"): retry it as exact text.
    let literalNotice: string | undefined;
    if (result.items.length === 0 && !result.nextCursor && !resumed && mode === "regex") {
      const plain = picker.grep(query, { ...base, mode: "plain", cursor: null, beforeContext: context, afterContext: context });
      if (plain.ok && plain.value.items.length > 0) {
        mode = "plain";
        result = plain.value;
        literalNotice = "0 regex matches; matched as literal text";
      }
    }

    // Plain search with nothing found: try fuzzy. A pinned file broadens to the whole index
    // (it may just be misnamed); a directory constraint stays so excluded paths do not leak.
    let fuzzyNotice: string | undefined;
    if (result.items.length === 0 && !result.nextCursor && !params.cursor && mode !== "regex" && !literal) {
      const lastSeg = params.path?.split(/[\\/]/).pop() ?? "";
      const pathTargetsFile = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSeg);
      const fuzzy = picker.grep(pathTargetsFile ? pattern : query, {
        ...base,
        mode: "fuzzy",
        cursor: null,
        beforeContext: 0,
        afterContext: 0,
      });
      if (fuzzy.ok && fuzzy.value.items.length > 0) {
        fuzzyNotice = "0 exact matches. Maybe you meant this?";
        result = fuzzy.value;
      }
    }

    let text = formatGrepOutput(result);
    const notices: string[] = [];
    if (result.regexFallbackError) notices.push(`Invalid regex: ${result.regexFallbackError}, used literal match`);
    if (literalNotice) notices.push(literalNotice);
    if (result.nextCursor) notices.push(`Continue with cursor="${grepCursors.store({ cursor: result.nextCursor, mode })}"`);
    if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
    if (fuzzyNotice) text = `[${fuzzyNotice}]\n${text}`;
    return { text, metadata: { totalMatched: result.totalMatched, totalFiles: result.totalFiles } };
  }

  /** One page of a snapshot, with a cursor for the rest. */
  function findPage(snapshot: FindCursor, notices: string[] = []): ToolOutput {
    const page = snapshot.entries.slice(snapshot.offset, snapshot.offset + snapshot.pageSize);
    const next = snapshot.offset + page.length;
    const remaining = snapshot.entries.length - next;
    let text = page.length ? page.map((e) => `${e.path}${e.note}`).join("\n") : "No files found matching pattern";
    if (remaining > 0) {
      const cursor = findCursors.store({ ...snapshot, offset: next });
      notices.push(`${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursor}" to continue`);
    } else if (snapshot.unfetched > 0) {
      notices.push(`${snapshot.unfetched} more matches not shown; narrow the pattern or path`);
    }
    if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
    return {
      text,
      metadata: {
        totalMatched: snapshot.entries.length + snapshot.unfetched,
        offset: snapshot.offset,
        hasMore: remaining > 0,
      },
    };
  }

  async function find(params: FindParams): Promise<ToolOutput> {
    if (params.cursor) {
      const resumed = findCursors.get(params.cursor);
      if (!resumed) throw new Error(`Unknown or expired cursor "${params.cursor}"; run the search again.`);
      return findPage(resumed);
    }

    const pattern = params.pattern ?? "";
    const aux = await auxFor(params.path, pattern, params.exclude);
    const picker = aux ? aux.finder : await mainFinder();
    const root = aux ? aux.root : cwd;
    const pathParam = aux ? aux.path : params.path;
    const limit = Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);
    const entry = (item: { relativePath: string }) => ({ path: item.relativePath, note: fileAnnotation(item) });
    const constraint = pathParam ? normalizePathConstraint(pathParam, root) : null;

    // Listing a path: an exact glob, not a fuzzy query that also matches unrelated paths.
    if (isListingPattern(pattern)) {
      const listed = picker.glob(constraint ? constraintGlob(constraint) : "**", { pageSize: LIST_SNAPSHOT_MAX });
      if (!listed.ok) throw new Error(listed.error);
      const keep = excludeFilter(normalizeExcludes(params.exclude, root));
      const entries = listed.value.items.filter((item) => keep(item.relativePath)).map(entry);
      return findPage({ entries, pageSize: limit, offset: 0, unfetched: Math.max(0, listed.value.totalMatched - listed.value.items.length) });
    }

    const query = aux ? aux.query : buildQuery(params.path, pattern, params.exclude, cwd);
    const search = picker.fileSearch(query, { pageIndex: 0, pageSize: FIND_SNAPSHOT_MAX });
    if (!search.ok) throw new Error(search.error);
    const result = search.value;
    const unfetched = Math.max(0, result.totalMatched - result.items.length);

    // A name containing glob characters ("weird-[brackets].txt") is parsed as a glob and matches
    // nothing; fall back to a literal substring match over the indexed paths.
    if (result.items.length === 0 && /[*?[{]/.test(pattern) && !isListingPattern(pattern)) {
      const all = picker.glob("**", { pageSize: 1_000_000 });
      if (all.ok) {
        const needle = pattern.toLowerCase();
        const keep = excludeFilter(normalizeExcludes(params.exclude, root));
        const prefix = constraint && constraint.endsWith("/") ? constraint : "";
        const entries = all.value.items
          .filter((item) => item.relativePath.toLowerCase().includes(needle) && item.relativePath.startsWith(prefix) && keep(item.relativePath))
          .map(entry);
        if (entries.length > 0) {
          return findPage({ entries, pageSize: limit, offset: 0, unfetched: 0 }, [
            `No fuzzy match; "${pattern}" matched literally`,
          ]);
        }
      }
    }

    if (result.items.length === 0) return findPage({ entries: [], pageSize: limit, offset: 0, unfetched: 0 });

    // Scattered fuzzy noise: show a small sample rather than the whole snapshot.
    if (!isListingPattern(pattern) && (result.scores[0]?.total ?? 0) < weakScoreThreshold(pattern)) {
      const sample = result.items.slice(0, Math.min(FIND_WEAK_SAMPLE_SIZE, limit)).map(entry);
      return findPage({ entries: sample, pageSize: limit, offset: 0, unfetched: 0 }, [
        `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${sample.length}/${result.totalMatched}.`,
      ]);
    }

    return findPage({ entries: result.items.map(entry), pageSize: limit, offset: 0, unfetched });
  }

  /** Warms the workspace index in the background so the first search is fast. */
  function warm(): void {
    mainFinder().catch((error) => options.onWarning?.(`FFF init failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  function dispose(): void {
    pool.destroy();
    const pending = main;
    main = undefined;
    pending?.then((finder) => finder.destroy()).catch(() => {});
  }

  return { grep, find, externalRoot, warm, dispose, cwd };
}

export type FffTools = ReturnType<typeof createFffTools>;
