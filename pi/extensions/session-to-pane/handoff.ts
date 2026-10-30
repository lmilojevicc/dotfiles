import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export interface HandoffReadinessExpectation {
  handoffPath: string;
  nonce: string;
  sessionPath: string;
  sessionId: string;
}

export interface HandoffReadinessResult {
  ok: boolean;
  error?: string;
}

export interface HandoffReadyData {
  version: 1;
  ok?: true;
  sessionPath: string;
  sessionId: string;
  nonce: string;
}

/** A child that refused or failed to restore the editor, so the parent can report why. */
export interface HandoffRejectionData {
  version: 1;
  ok: false;
  nonce: string;
  reason: string;
}

export type HandoffAcknowledgement = HandoffReadyData | HandoffRejectionData;

const MAX_REJECTION_REASON_LENGTH = 512;

export function getHandoffReadyPath(handoffPath: string): string {
  return join(dirname(handoffPath), "ready.json");
}

function readProtectedReady(readyPath: string): HandoffAcknowledgement {
  const parent = dirname(readyPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const dirStat = lstatSync(parent);
  const fileStat = lstatSync(readyPath);
  if (!dirStat.isDirectory() || (dirStat.mode & 0o077) !== 0 || (uid !== undefined && dirStat.uid !== uid)) {
    throw new Error("Unsafe readiness acknowledgement directory");
  }
  if (!fileStat.isFile() || fileStat.nlink !== 1 || (fileStat.mode & 0o077) !== 0 || (uid !== undefined && fileStat.uid !== uid)) {
    throw new Error("Unsafe readiness acknowledgement file");
  }
  if (fileStat.size <= 0 || fileStat.size > 16 * 1024) {
    throw new Error("Invalid readiness acknowledgement size");
  }
  const parsed = JSON.parse(readFileSync(readyPath, "utf8")) as Partial<HandoffReadyData & HandoffRejectionData>;
  if (parsed.version !== 1) throw new Error("Invalid readiness acknowledgement");
  if (parsed.ok === false) {
    if (
      typeof parsed.nonce !== "string" ||
      typeof parsed.reason !== "string" ||
      parsed.reason.length === 0 ||
      parsed.reason.length > MAX_REJECTION_REASON_LENGTH
    ) {
      throw new Error("Invalid readiness acknowledgement");
    }
    return parsed as HandoffRejectionData;
  }
  if (
    typeof parsed.sessionPath !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.nonce !== "string"
  ) {
    throw new Error("Invalid readiness acknowledgement");
  }
  return parsed as HandoffReadyData;
}

export async function waitForHandoffReady(
  expected: HandoffReadinessExpectation,
  timeoutMs: number,
  pollIntervalMs = 50,
): Promise<HandoffReadinessResult> {
  const readyPath = getHandoffReadyPath(expected.handoffPath);
  const expectedSessionPath = realpathSync(expected.sessionPath);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (existsSync(readyPath)) {
      try {
        const ready = readProtectedReady(readyPath);
        if (ready.ok === false) {
          if (ready.nonce !== expected.nonce) {
            return { ok: false, error: "Child Pi returned a mismatched readiness acknowledgement" };
          }
          return { ok: false, error: `Child Pi could not restore the editor: ${ready.reason}` };
        }
        if (
          ready.nonce !== expected.nonce ||
          ready.sessionId !== expected.sessionId ||
          ready.sessionPath !== expectedSessionPath
        ) {
          return { ok: false, error: "Child Pi returned a mismatched readiness acknowledgement" };
        }
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: `Child Pi returned an invalid readiness acknowledgement: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: "Timed out waiting for child Pi to restore the editor" };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(pollIntervalMs, remaining)));
  }
}
