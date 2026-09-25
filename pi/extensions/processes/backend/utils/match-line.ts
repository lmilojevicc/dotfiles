// Source: @aliou/pi-processes 0.12.0; local compatibility patches: ../UPSTREAM.md.
/**
 * Shared line-matching logic used by both the notification log-matchers
 * and the output tool action. Pi-agnostic — no Pi imports.
 */

export type LineMatchMode = "literal" | "regex";

/**
 * Compile a pattern + mode into a line-matching predicate.
 *
 * - literal: substring match (case-sensitive).
 * - regex: explicitly rejected locally (unbounded upstream evaluation).
 */
export function compileLineMatcher(
  pattern: string,
  mode: LineMatchMode,
): (line: string) => boolean {
  // Guard against the match-all footgun for an empty pattern. An empty
  // literal would match every line via String#includes(""), and an empty
  // regex matches at every position. Callers should treat "" as "no filter",
  // but defend here too so the shared primitive can never become a match-all.
  if (pattern.length === 0) {
    return () => false;
  }

  if (mode === "literal") {
    return (line) => line.includes(pattern);
  }

  throw new Error("Regex is unsupported in v1; use literal matching");
}
