// Source: @aliou/pi-processes 0.12.0; local compatibility patches: ../UPSTREAM.md.
import type { ProcessNotificationDetails } from "./types.ts";

const NOTIFICATION_WINDOW_MS = 60_000;
const MAX_LOG_MATCH_NOTIFICATIONS_PER_WINDOW = 20;

/** Upstream aggregate watch throttle, adapted to a private delivery callback. */
export function createNotificationThrottle(
  deliver: (details: ProcessNotificationDetails) => void,
  now: () => number = () => performance.now(),
): { send: (payload: ProcessNotificationDetails) => void; dispose: () => void } {
  let windowStart: number | null = null;
  let sentInWindow = 0;
  let suppressed = 0;
  let summaryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearSummaryTimer = () => {
    if (!summaryTimer) return;
    clearTimeout(summaryTimer);
    summaryTimer = null;
  };

  const resetWindow = (): number => {
    clearSummaryTimer();
    const count = suppressed;
    windowStart = null;
    sentInWindow = 0;
    suppressed = 0;
    return count;
  };

  const sendSuppressedSummary = (count: number) => {
    if (count === 0) return;
    const details: ProcessNotificationDetails = {
      kind: "log_match_suppressed",
      suppressedCount: count,
      processId: "*",
      processName: "log watches",
      command: "",
      timestamp: Date.now(),
      summary: `Suppressed ${count} log-match notifications because output was too fast.`,
      attention: "context",
    };
    deliver(details);
  };

  const flushSuppressedSummary = () => {
    const count = resetWindow();
    sendSuppressedSummary(count);
  };

  const startWindow = (now: number) => {
    windowStart = now;
    sentInWindow = 0;
    suppressed = 0;
    clearSummaryTimer();
    summaryTimer = setTimeout(flushSuppressedSummary, NOTIFICATION_WINDOW_MS);
    summaryTimer.unref?.();
  };

  let disposed = false;
  return {
    send(payload) {
      if (disposed) return;
      if (payload.kind === "log_match") {
        const time = now();
        if (windowStart === null || time - windowStart >= NOTIFICATION_WINDOW_MS) {
          const previousSuppressed = windowStart === null ? 0 : resetWindow();
          startWindow(time);
          sendSuppressedSummary(previousSuppressed);
        }
        if (sentInWindow >= MAX_LOG_MATCH_NOTIFICATIONS_PER_WINDOW) {
          suppressed++;
          return;
        }
        sentInWindow++;
      }
      deliver(payload);
    },
    dispose() {
      disposed = true;
      resetWindow();
    },
  };
}
