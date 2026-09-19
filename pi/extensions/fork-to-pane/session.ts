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
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  CURRENT_SESSION_VERSION,
  SessionManager,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import {
  getHandoffReadyPath,
  type HandoffReadyData,
} from "./handoff.ts";

export { getHandoffReadyPath, waitForHandoffReady } from "./handoff.ts";

export interface SessionReader {
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getSessionDir(): string;
  getEntry(id: string): SessionEntry | undefined;
}

const MAX_HANDOFF_BYTES = 1024 * 1024;
export const HANDOFF_PATH_ENV = "PI_FORK_TO_PANE_HANDOFF";
export const HANDOFF_NONCE_ENV = "PI_FORK_TO_PANE_NONCE";

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

export interface HandoffData {
  version: 1;
  forkSessionPath: string;
  forkSessionId: string;
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

export function createHandoff(fork: CreatedFork): Handoff {
  const nonce = randomBytes(32).toString("hex");
  const data: HandoffData = {
    version: 1,
    forkSessionPath: resolve(fork.path),
    forkSessionId: fork.sessionId,
    editorText: fork.editorText,
    nonce,
  };
  const serialized = `${JSON.stringify(data)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_HANDOFF_BYTES) {
    throw new Error("The selected prompt is too large to restore safely");
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-fork-to-pane-"));
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
    typeof parsed.forkSessionPath !== "string" ||
    typeof parsed.forkSessionId !== "string" ||
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
  data: HandoffReadyData,
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

export function restoreEditorFromHandoff(
  ctx: { mode: string; sessionManager: SessionReader; ui: { setEditorText(text: string): void } },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const handoffPath = env[HANDOFF_PATH_ENV];
  const nonce = env[HANDOFF_NONCE_ENV];
  if (!handoffPath || !nonce || !existsSync(handoffPath)) return false;

  let consumedPath: string | undefined;
  let acknowledged = false;
  try {
    const data = readProtectedHandoff(handoffPath);
    consumedPath = `${handoffPath}.consuming`;
    renameSync(handoffPath, consumedPath);
    if (ctx.mode !== "tui" || data.nonce !== nonce) return false;
    const currentFile = ctx.sessionManager.getSessionFile();
    if (!currentFile || ctx.sessionManager.getSessionId() !== data.forkSessionId) return false;
    const forkSessionPath = realpathSync(data.forkSessionPath);
    if (realpathSync(currentFile) !== forkSessionPath) return false;
    ctx.ui.setEditorText(data.editorText);
    unlinkSync(consumedPath);
    consumedPath = undefined;
    publishHandoffReady(handoffPath, {
      version: 1,
      forkSessionPath,
      forkSessionId: data.forkSessionId,
      nonce: data.nonce,
    });
    acknowledged = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!acknowledged) cleanupHandoff(consumedPath ?? handoffPath);
  }
}
