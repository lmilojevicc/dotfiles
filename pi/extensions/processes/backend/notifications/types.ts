// Source: @aliou/pi-processes 0.12.0; local compatibility patches: ../UPSTREAM.md.
import type { Run } from "../../types.ts";
import type { ProcessInfo, ProcessEndReason, ProcessSignalInfo, ProcessStatus } from "../types.ts";
export type Attention = "turn" | "context" | "ignore";
export type ProcessNotificationKind = "success" | "failure" | "crash" | "killed" | "log_match" | "log_match_suppressed";
export interface ProcessNotificationDetails {
  kind: ProcessNotificationKind;
  processId: string; processName: string; command: string; timestamp: number; summary: string;
  status?: ProcessStatus; exitCode?: number | null; endReason?: ProcessEndReason | null;
  signal?: ProcessSignalInfo | null;
  logMatch?: { pattern: string; mode: "literal" | "regex"; stream: "stdout" | "stderr"; line: string; matcherIndex: number };
  attention: Attention;
  info?: ProcessInfo;
  run?: Run;
  suppressedCount?: number;
}
