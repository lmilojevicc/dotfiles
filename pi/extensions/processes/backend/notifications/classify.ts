// Source: @aliou/pi-processes 0.12.0; local compatibility patches: ../UPSTREAM.md.
import type { ProcessInfo } from "../types.ts";
import type { ProcessNotificationKind } from "./types.ts";

/**
 * Classify a process end into a notification kind.
 *
 * Local timeouts remain live; genuine later exits are classified normally.
 */
export function classifyProcessEnd(info: ProcessInfo): ProcessNotificationKind {
  if (info.status === "killed") return "killed";
  if (info.success === true) return "success";

  if (
    info.endReason === "spawn_error" ||
    info.endReason === "missing_pid" ||
    info.endReason === "lost"
  ) {
    return "crash";
  }

  if (info.exitCode !== null && info.exitCode !== 0) return "crash";

  return "failure";
}
