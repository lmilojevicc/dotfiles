import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { Watch } from '../types.ts';
import { safeText } from '../status.ts';
import { watch as validWatch } from './validation.ts';

export function buildMatcherLine(
  matcher: Watch,
  theme: Theme,
  prefix = "",
): Text {
  if (!validWatch(matcher)) return new Text(theme.fg('warning', 'watch unavailable · malformed details'), 0, 0);
  const mode = matcher.mode ?? "literal";
  const stream = matcher.stream ?? "both";
  const repeat = matcher.repeat ? " (repeat)" : "";
  const on = matcher.on ?? "turn";
  const attentionTone =
    on === "turn" ? "warning" : on === "context" ? "success" : "muted";

  const pattern = quoteFilter(formatPatternForDisplay(safeText(matcher.pattern).slice(0, 500)), 'literal');

  return new Text(
    [
      safeText(prefix),
      theme.fg("muted", `[${stream}] ${mode}`),
      "  ",
      theme.bold(theme.fg(attentionTone, `${on}${repeat}`)),
      "  ",
      theme.fg("accent", pattern),
    ].join(""),
    0,
    0,
  );
}

export function quoteFilter(
  pattern: string,
  mode: "literal" | "regex",
): string {
  if (mode === "regex") return `/${pattern}/`;
  if (pattern.includes('"')) return `'${pattern}'`;
  return `"${pattern}"`;
}

export function formatPatternForDisplay(pattern: string): string {
  let formatted = "";

  for (const character of pattern) {
    if (character === "\r") {
      formatted += "\\r";
    } else if (character === "\n") {
      formatted += "\\n";
    } else if (character === "\t") {
      formatted += "\\t";
    } else {
      const codePoint = character.codePointAt(0) ?? 0;
      if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
        formatted += `\\x${codePoint.toString(16).padStart(2, "0")}`;
      } else {
        formatted += character;
      }
    }
  }

  return formatted;
}
