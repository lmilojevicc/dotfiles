import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  getHandoffReadyPath,
  type HandoffReadyData,
  type HandoffRejectionData,
} from "./handoff.ts";

export { getHandoffReadyPath, waitForHandoffReady } from "./handoff.ts";

export interface SessionReader {
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getSessionDir(): string;
  getCwd(): string;
  getEntry(id: string): SessionEntry | undefined;
  getEntries(): SessionEntry[];
  getLeafId(): string | null;
}

const MAX_HANDOFF_BYTES = 1024 * 1024;
export const HANDOFF_PATH_ENV = "PI_SESSION_TO_PANE_HANDOFF";
export const HANDOFF_NONCE_ENV = "PI_SESSION_TO_PANE_NONCE";
export const POSITION_MARKER_TYPE = "session-to-pane-position";

export interface ForkCandidate {
  entryId: string;
  text: string;
}

export type ForkThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ForkRuntimeState {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ForkThinkingLevel;
}

export interface ForkSnapshot extends ForkCandidate {
  parentId: string | null;
  sourceFile: string;
  sourceSessionId: string;
  sessionDir: string;
  runtimeState?: ForkRuntimeState;
}

export interface CreatedFork {
  path: string;
  sessionId: string;
  editorText: string;
  launchState?: ForkRuntimeState;
}

export type FullTreeCopyMode = "tree" | "clone";

export interface FullTreeSnapshot {
  mode: FullTreeCopyMode;
  sourceFile: string;
  sourceSessionId: string;
  sourceCwd: string;
  sessionDir: string;
  sourceBytes: string;
  sourceEntries: SessionEntry[];
  sourceRuntimeLeafId: string | null;
  targetLeafId: string | null;
  selectedEntryId?: string;
  selectedEntry?: SessionEntry;
  editorText: string;
  runtimeState?: ForkRuntimeState;
}

export interface HandoffData {
  version: 1;
  sessionPath: string;
  sessionId: string;
  editorText: string;
  nonce: string;
}

export interface Handoff {
  path: string;
  nonce: string;
}

export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string")
    )
    .map((part) => part.text)
    .join("");
}

export function getForkCandidates(entries: readonly SessionEntry[]): ForkCandidate[] {
  const candidates: ForkCandidate[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = extractUserText(entry.message.content);
    if (text) candidates.push({ entryId: entry.id, text });
  }
  return candidates;
}

// SessionManager keeps undefined optional fields in live entries, while JSONL persistence omits them.
function persistedClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function captureFullTreeBase(
  sessionManager: SessionReader,
  mode: FullTreeCopyMode,
  editorText: string,
  targetLeafId: string | null,
  runtimeState?: ForkRuntimeState,
): FullTreeSnapshot {
  const sourceFile = sessionManager.getSessionFile();
  if (!sourceFile) throw new Error("The current session is not persisted");
  if (!existsSync(sourceFile)) throw new Error("The current session has not been saved yet");
  return {
    mode,
    sourceFile: resolve(sourceFile),
    sourceSessionId: sessionManager.getSessionId(),
    sourceCwd: sessionManager.getCwd(),
    sessionDir: sessionManager.getSessionDir(),
    sourceBytes: readFileSync(sourceFile, "utf8"),
    sourceEntries: persistedClone(sessionManager.getEntries()),
    sourceRuntimeLeafId: sessionManager.getLeafId(),
    targetLeafId,
    editorText,
    runtimeState,
  };
}

export function captureCloneSnapshot(
  sessionManager: SessionReader,
  editorText: string,
  runtimeState?: ForkRuntimeState,
): FullTreeSnapshot {
  return captureFullTreeBase(sessionManager, "clone", editorText, sessionManager.getLeafId(), runtimeState);
}

export function captureTreeSnapshot(
  sessionManager: SessionReader,
  selectedEntryId: string,
  runtimeState?: ForkRuntimeState,
): FullTreeSnapshot {
  const selected = sessionManager.getEntry(selectedEntryId);
  if (!selected) throw new Error("The selected tree entry is no longer available");
  const editsPrompt = (selected.type === "message" && selected.message.role === "user") || selected.type === "custom_message";
  const editorText = selected.type === "message" && selected.message.role === "user"
    ? extractUserText(selected.message.content)
    : selected.type === "custom_message"
      ? extractUserText(selected.content)
      : "";
  return {
    ...captureFullTreeBase(
      sessionManager,
      "tree",
      editorText,
      editsPrompt ? selected.parentId : selected.id,
      runtimeState,
    ),
    selectedEntryId,
    selectedEntry: persistedClone(selected),
  };
}

export function captureForkSnapshot(
  sessionManager: SessionReader,
  candidate: ForkCandidate,
  runtimeState?: ForkRuntimeState,
): ForkSnapshot {
  const sourceFile = sessionManager.getSessionFile();
  if (!sourceFile) throw new Error("The current session is not persisted");
  if (!existsSync(sourceFile)) {
    throw new Error("The current session has not been saved yet");
  }
  const entry = sessionManager.getEntry(candidate.entryId);
  if (!entry || entry.type !== "message" || entry.message.role !== "user") {
    throw new Error("The selected message is no longer available");
  }
  const text = extractUserText(entry.message.content);
  if (text !== candidate.text) throw new Error("The selected message changed");
  return {
    ...candidate,
    parentId: entry.parentId,
    sourceFile: resolve(sourceFile),
    sourceSessionId: sessionManager.getSessionId(),
    sessionDir: sessionManager.getSessionDir(),
    runtimeState,
  };
}

function writeSessionFile(file: string, header: SessionHeader, entries: readonly SessionEntry[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(file, "wx", 0o600);
    created = true;
    fchmodSync(fd, 0o600);
    const serialized = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(fd, serialized, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(file); } catch {}
    }
    throw error;
  }
}

function writeRootFork(source: SessionManager): { path: string; sessionId: string } {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionDir = source.getSessionDir();
  const file = join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const sourceFile = source.getSessionFile();
  if (!sourceFile) throw new Error("Persisted source session is missing its file");
  const header: SessionHeader = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: source.getCwd(),
    parentSession: sourceFile,
  };
  writeSessionFile(file, header, []);
  return { path: file, sessionId };
}

const THINKING_LEVELS = new Set<ForkThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function launchStateForEmptyFork(source: SessionManager, runtimeState?: ForkRuntimeState): ForkRuntimeState | undefined {
  const context = source.buildSessionContext();
  if (context.messages.length > 0) return undefined;

  const branch = source.getBranch();
  const hasHistoricalThinking = branch.some((entry) => entry.type === "thinking_level_change");
  const historicalThinking = THINKING_LEVELS.has(context.thinkingLevel as ForkThinkingLevel)
    ? context.thinkingLevel as ForkThinkingLevel
    : undefined;
  const model = context.model ?? runtimeState?.model;
  const thinkingLevel = hasHistoricalThinking ? historicalThinking : runtimeState?.thinkingLevel;
  if (!model && !thinkingLevel) return undefined;
  return { model, thinkingLevel };
}

/** Create a fork without mutating the command context's SessionManager. */
export function createForkFromSnapshot(snapshot: ForkSnapshot): CreatedFork {
  const source = SessionManager.open(snapshot.sourceFile, snapshot.sessionDir);
  const header = source.getHeader();
  if (!header || header.id !== snapshot.sourceSessionId || resolve(snapshot.sourceFile) !== resolve(source.getSessionFile() ?? "")) {
    throw new Error("The source session changed while choosing a message");
  }
  const selected = source.getEntry(snapshot.entryId);
  if (
    !selected ||
    selected.type !== "message" ||
    selected.message.role !== "user" ||
    selected.parentId !== snapshot.parentId ||
    extractUserText(selected.message.content) !== snapshot.text
  ) {
    throw new Error("The selected message changed while choosing a fork point");
  }

  if (selected.parentId === null) {
    const root = writeRootFork(source);
    return { ...root, editorText: snapshot.text, launchState: snapshot.runtimeState };
  }

  const forkPath = source.createBranchedSession(selected.parentId);
  if (!forkPath) throw new Error("Pi could not create the selected fork");
  const launchState = launchStateForEmptyFork(source, snapshot.runtimeState);
  if (!existsSync(forkPath)) {
    const forkHeader = source.getHeader();
    if (!forkHeader || forkHeader.version !== CURRENT_SESSION_VERSION || forkHeader.id !== source.getSessionId()) {
      throw new Error("Pi returned an invalid unmaterialized fork");
    }
    writeSessionFile(forkPath, forkHeader, source.getEntries());
  }
  const fork = SessionManager.open(forkPath, snapshot.sessionDir);
  return {
    path: resolve(forkPath),
    sessionId: fork.getSessionId(),
    editorText: snapshot.text,
    launchState,
  };
}

function removeOwnedFullTreeCopy(path: string, sessionId: string, sourceFile: string): void {
  try {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
    const header = JSON.parse(firstLine) as Partial<SessionHeader>;
    if (
      header.type === "session" &&
      header.id === sessionId &&
      typeof header.parentSession === "string" &&
      resolve(header.parentSession) === resolve(sourceFile)
    ) {
      unlinkSync(path);
    }
  } catch {}
}

/** Copy a complete session tree and append a non-context marker whose parent records the intended active position. */
export function createFullTreeFromSnapshot(
  snapshot: FullTreeSnapshot,
  liveSource?: SessionReader,
): CreatedFork {
  if (liveSource) {
    if (
      resolve(liveSource.getSessionFile() ?? "") !== snapshot.sourceFile ||
      liveSource.getSessionId() !== snapshot.sourceSessionId ||
      (snapshot.mode === "clone" && liveSource.getLeafId() !== snapshot.sourceRuntimeLeafId)
    ) {
      throw new Error("The source session position changed while choosing a destination");
    }
  }
  if (readFileSync(snapshot.sourceFile, "utf8") !== snapshot.sourceBytes) {
    throw new Error("The source session changed while choosing a destination");
  }

  const source = SessionManager.open(snapshot.sourceFile, snapshot.sessionDir);
  const sourceHeader = source.getHeader();
  if (
    !sourceHeader ||
    sourceHeader.id !== snapshot.sourceSessionId ||
    resolve(source.getSessionFile() ?? "") !== snapshot.sourceFile ||
    !isDeepStrictEqual(source.getEntries(), snapshot.sourceEntries)
  ) {
    throw new Error("The source session changed while choosing a destination");
  }
  if (snapshot.selectedEntryId) {
    const selected = source.getEntry(snapshot.selectedEntryId);
    if (!selected || !isDeepStrictEqual(selected, snapshot.selectedEntry)) {
      throw new Error("The selected tree entry changed while choosing a destination");
    }
  }
  if (snapshot.targetLeafId !== null && !source.getEntry(snapshot.targetLeafId)) {
    throw new Error("The selected tree position is no longer available");
  }

  const copyId = randomUUID();
  let copyPath: string | undefined;
  try {
    const copy = SessionManager.forkFrom(snapshot.sourceFile, snapshot.sourceCwd, snapshot.sessionDir, { id: copyId });
    copyPath = resolve(copy.getSessionFile() ?? "");
    if (!copyPath || copy.getSessionId() !== copyId || copyPath === snapshot.sourceFile) {
      throw new Error("Pi returned an invalid full-tree copy");
    }
    const header = copy.getHeader();
    if (
      !header ||
      header.id !== copyId ||
      resolve(header.parentSession ?? "") !== snapshot.sourceFile ||
      !isDeepStrictEqual(copy.getEntries(), snapshot.sourceEntries)
    ) {
      throw new Error("Pi did not preserve the complete session tree");
    }

    if (snapshot.targetLeafId === null) copy.resetLeaf();
    else copy.branch(snapshot.targetLeafId);
    const markerId = copy.appendCustomEntry(POSITION_MARKER_TYPE, {
      sourceLeafId: snapshot.targetLeafId,
      mode: snapshot.mode,
    });

    const reopened = SessionManager.open(copyPath, snapshot.sessionDir);
    const entries = reopened.getEntries();
    const marker = entries.at(-1);
    if (
      entries.length !== snapshot.sourceEntries.length + 1 ||
      !isDeepStrictEqual(entries.slice(0, -1), snapshot.sourceEntries) ||
      !marker || marker.id !== markerId || marker.type !== "custom" ||
      marker.customType !== POSITION_MARKER_TYPE || marker.parentId !== snapshot.targetLeafId ||
      reopened.getLeafId() !== markerId
    ) {
      throw new Error("Pi could not verify the copied session position");
    }
    if (readFileSync(snapshot.sourceFile, "utf8") !== snapshot.sourceBytes) {
      throw new Error("The source session changed while creating the copy");
    }
    return {
      path: copyPath,
      sessionId: copyId,
      editorText: snapshot.editorText,
      launchState: snapshot.runtimeState,
    };
  } catch (error) {
    if (copyPath) {
      removeOwnedFullTreeCopy(copyPath, copyId, snapshot.sourceFile);
    } else {
      // forkFrom writes incrementally. A predetermined fresh ID lets us identify and
      // remove only its partial output if the public API throws after creating it.
      try {
        const suffix = `_${copyId}.jsonl`;
        for (const name of readdirSync(snapshot.sessionDir)) {
          if (name.endsWith(suffix)) removeOwnedFullTreeCopy(join(snapshot.sessionDir, name), copyId, snapshot.sourceFile);
        }
      } catch {}
    }
    throw error;
  }
}

export function createHandoff(fork: CreatedFork): Handoff {
  const nonce = randomBytes(32).toString("hex");
  const data: HandoffData = {
    version: 1,
    sessionPath: resolve(fork.path),
    sessionId: fork.sessionId,
    editorText: fork.editorText,
    nonce,
  };
  const serialized = `${JSON.stringify(data)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_HANDOFF_BYTES) {
    throw new Error("The selected prompt is too large to restore safely");
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-session-to-pane-"));
  chmodSync(dir, 0o700);
  const handoffPath = join(dir, "handoff.json");
  try {
    writeFileSync(handoffPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(handoffPath, 0o600);
    return { path: handoffPath, nonce };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export function cleanupHandoff(handoffPath: string): void {
  try {
    const parent = dirname(handoffPath);
    const stat = lstatSync(parent);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return;
    if (!basename(handoffPath).startsWith("handoff.json")) return;
    rmSync(parent, { recursive: true, force: true });
  } catch {}
}

function assertProtectedFile(file: string, maxBytes: number, kind: string): void {
  const parent = dirname(file);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const dirStat = lstatSync(parent);
  const fileStat = lstatSync(file);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 || (uid !== undefined && dirStat.uid !== uid)) {
    throw new Error(`Unsafe ${kind} directory`);
  }
  if (!fileStat.isFile() || fileStat.nlink !== 1 || (fileStat.mode & 0o077) !== 0 || (uid !== undefined && fileStat.uid !== uid)) {
    throw new Error(`Unsafe ${kind} file`);
  }
  if (fileStat.size <= 0 || fileStat.size > maxBytes) throw new Error(`Invalid ${kind} size`);
}

function readProtectedHandoff(handoffPath: string): HandoffData {
  if (!resolve(handoffPath).startsWith(resolve(tmpdir()) + "/")) throw new Error("Invalid handoff location");
  assertProtectedFile(handoffPath, MAX_HANDOFF_BYTES, "handoff");
  const parsed = JSON.parse(readFileSync(handoffPath, "utf8")) as Partial<HandoffData>;
  if (
    parsed.version !== 1 ||
    typeof parsed.sessionPath !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.editorText !== "string" ||
    typeof parsed.nonce !== "string"
  ) {
    throw new Error("Invalid handoff data");
  }
  return parsed as HandoffData;
}

type PublishReadyFile = (temporaryPath: string, readyPath: string) => void;

export function publishHandoffReady(
  handoffPath: string,
  data: HandoffReadyData | HandoffRejectionData,
  publish: PublishReadyFile = renameSync,
): void {
  const readyPath = getHandoffReadyPath(handoffPath);
  const temporaryPath = join(dirname(readyPath), `.ready-${randomBytes(16).toString("hex")}.tmp`);
  let fd: number | undefined;
  let temporaryCreated = false;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(data)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    publish(temporaryPath, readyPath);
    temporaryCreated = false;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (temporaryCreated) {
      try { unlinkSync(temporaryPath); } catch {}
    }
    throw error;
  }
}

/**
 * Tell the parent why this child could not restore the editor, so it fails with that reason instead
 * of polling until its readiness deadline. The parent owns the temporary directory and removes it.
 */
function rejectHandoff(handoffPath: string, nonce: string, reason: string): false {
  try {
    // The parent rejects reasons over 512 characters as malformed; keep the reason it can show.
    publishHandoffReady(handoffPath, { version: 1, ok: false, nonce, reason: reason.length > 512 ? `${reason.slice(0, 511)}…` : reason });
  } catch {}
  return false;
}

export function restoreEditorFromHandoff(
  ctx: { mode: string; sessionManager: SessionReader; ui: { setEditorText(text: string): void } },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const handoffPath = env[HANDOFF_PATH_ENV];
  const nonce = env[HANDOFF_NONCE_ENV];
  if (!handoffPath || !nonce || !existsSync(handoffPath)) return false;

  let handoff: HandoffData | undefined;
  let consumedPath: string | undefined;
  let acknowledged = false;
  try {
    handoff = readProtectedHandoff(handoffPath);
    consumedPath = `${handoffPath}.consuming`;
    renameSync(handoffPath, consumedPath);
    if (ctx.mode !== "tui") {
      return rejectHandoff(handoffPath, handoff.nonce, "the child Pi is not running in interactive TUI mode");
    }
    if (handoff.nonce !== nonce) return rejectHandoff(handoffPath, handoff.nonce, "the handoff nonce does not match");
    const currentFile = ctx.sessionManager.getSessionFile();
    if (!currentFile || ctx.sessionManager.getSessionId() !== handoff.sessionId) {
      return rejectHandoff(handoffPath, handoff.nonce, "the child session id does not match the handoff");
    }
    const sessionPath = realpathSync(handoff.sessionPath);
    if (realpathSync(currentFile) !== sessionPath) {
      return rejectHandoff(handoffPath, handoff.nonce, "the child session file does not match the handoff");
    }
    ctx.ui.setEditorText(handoff.editorText);
    unlinkSync(consumedPath);
    consumedPath = undefined;
    publishHandoffReady(handoffPath, {
      version: 1,
      sessionPath,
      sessionId: handoff.sessionId,
      nonce: handoff.nonce,
    });
    acknowledged = true;
    return true;
  } catch (error) {
    if (handoff) {
      rejectHandoff(
        handoffPath,
        handoff.nonce,
        `restoring the editor failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  } finally {
    if (!acknowledged && consumedPath) {
      // Drop the prompt-bearing file; the temporary directory belongs to the parent, which created
      // it and cleans it up once it read this child's acknowledgement.
      try { unlinkSync(consumedPath); } catch {}
    }
  }
}
