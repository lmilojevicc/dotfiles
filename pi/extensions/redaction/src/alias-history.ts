import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { NativeConfig, Redactor } from "./contracts.ts";

// Bound traversal of existing history, not just native scans. Never concatenate raw messages.
const MAX_NODES = 100_000;
const MAX_TEXT_UNITS = 64 * 1024 * 1024;
const MAX_STRING_UNITS = 8 * 1024 * 1024;
const MAX_TOKENS = 10_000;
const families = { email: "EMAIL", phone: "PHONE", apiToken: "API_TOKEN", privateKey: "PRIVATE_KEY", credentialUrl: "CREDENTIAL_URL" } as const;

function reserveValues(values: Iterable<unknown>, detectors: NativeConfig["detectors"], redact: Redactor["redact"]): void {
  const enabled = Object.entries(families).filter(([kind]) => detectors[kind as keyof typeof families]).map(([, family]) => family);
  if (enabled.length === 0) return;
  const pattern = new RegExp(`\\[(?:${enabled.join("|")})_[0-9]+\\]`, "g");
  const seen = new WeakSet<object>();
  const tokens = new Set<string>();
  let nodes = 0, textUnits = 0;
  function visit(item: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > 100) throw new Error("Protected alias history unavailable");
    if (typeof item === "string") {
      textUnits += item.length;
      if (item.length > MAX_STRING_UNITS || textUnits > MAX_TEXT_UNITS) throw new Error("Protected alias history unavailable");
      for (const match of item.matchAll(pattern)) {
        const token = match[0];
        if (token.length > 64) throw new Error("Protected alias history unavailable");
        if (tokens.has(token)) continue;
        if (tokens.size >= MAX_TOKENS) throw new Error("Protected alias history unavailable");
        tokens.add(token);
        // Invalid/zero/leading-zero/overflow IDs reach native and must fail, never be silently skipped.
        const result = redact(token);
        if (result.text !== token || result.matches.length !== 0) throw new Error("Protected alias history unavailable");
      }
    } else if (item && typeof item === "object" && !seen.has(item)) {
      seen.add(item);
      if ((item as { type?: string }).type === "image" || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return;
      for (const key in item) {
        if (!Object.hasOwn(item, key) || /^(?:textSignature|thinkingSignature|thoughtSignature)$/.test(key)) continue;
        // Do not decode binary or signature fields. Property identities may contain model-visible tokens.
        visit(key, depth + 1);
        visit((item as Record<string, unknown>)[key], depth + 1);
      }
    }
  }
  for (const value of values) visit(value, 0);
}

/** Reserve only generated-token substrings; native validates numeric IDs without JS Number conversion. */
export function reserveGeneratedAliases(value: unknown, detectors: NativeConfig["detectors"], redact: Redactor["redact"]): void {
  reserveValues([value], detectors, redact);
}

/** Walk only the current branch's context-bearing entries, including edited/replaced history. */
export function reserveBranchAliases(entries: readonly SessionEntry[], detectors: NativeConfig["detectors"], redact: Redactor["redact"]): void {
  if (!Array.isArray(entries) || entries.length > MAX_NODES) throw new Error("Protected alias history unavailable");
  // A generator avoids an additional history-sized array or serialized raw transcript.
  function* content() {
    for (const entry of entries) {
      switch (entry.type) {
        case "message": yield entry.message; break;
        case "custom_message": yield entry.content; break;
        case "compaction": yield entry.summary; yield entry.systemMessage; break;
        case "branch_summary": yield entry.summary; break;
        case "context_edit": yield entry.replacement; break;
      }
    }
  }
  // One bounded traversal shares budgets and deduplication across every entry.
  reserveValues(content(), detectors, redact);
}
