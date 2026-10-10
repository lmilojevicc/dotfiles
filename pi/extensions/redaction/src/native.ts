import { createRequire } from "node:module";
import type { NativeConfig, RedactionMatch, RedactionResult, Redactor } from "./contracts.ts";

interface NativeInstance {
  redact(text: string): string;
  reset(): void;
  redactTextV1?: (text: string) => string | null;
  redactSpansUtf16V1?: (text: string) => RedactionResult | null;
  negativeProofAsciiV1?: () => string | null;
}
export interface NativeModule { NativeRedactor: new (configJson: string) => NativeInstance }
const kinds = new Set(["literal", "email", "phone", "apiToken", "privateKey", "credentialUrl"]);
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_MATCHES = 100_000;
// Native-certified necessary markers only, not a JS detector grammar.
const proofMarkers = new Set("[@0123456789-sgAx");
const MAX_PROOF_UNITS = 256;
const safeError = () => new Error("Redaction engine unavailable");

// Node >=22.18 supports this intrinsic; the package's ES2023 type library predates it.
function wellFormed(value: string): boolean {
  return (value as string & { isWellFormed(): boolean }).isWellFormed();
}
function checkString(value: unknown, maxBytes: number): asserts value is string {
  // Well-formed UTF-16 uses at most three UTF-8 bytes per code unit (a pair uses four).
  // This proves the byte cap for small fields without encoding/counting them again.
  if (typeof value !== "string" || value.length > maxBytes || !wellFormed(value) || (value.length > maxBytes / 3 && Buffer.byteLength(value, "utf8") > maxBytes)) throw safeError();
}
function checkMatches(value: unknown): asserts value is RedactionMatch[] {
  if (!Array.isArray(value) || value.length > MAX_MATCHES) throw safeError();
}
function checkMatch(match: RedactionMatch, previousEnd: number): void {
  if (!match || !kinds.has(match.kind) || typeof match.replacement !== "string" || !match.replacement || !wellFormed(match.replacement) || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end) || match.start < previousEnd || match.end <= match.start) throw safeError();
}
function scalarBoundary(input: string, index: number): boolean {
  return index === 0 || index === input.length || !(input.charCodeAt(index - 1) >= 0xd800 && input.charCodeAt(index - 1) <= 0xdbff && input.charCodeAt(index) >= 0xdc00 && input.charCodeAt(index) <= 0xdfff);
}

/** V1 null is a completed scan, including alias reservation and all native budgets. */
function convertUtf16Result(input: string, result: RedactionResult | null): RedactionResult {
  if (result === null) return { text: input, matches: [] };
  if (!result || typeof result !== "object") throw safeError();
  checkString(result.text, MAX_OUTPUT_BYTES);
  checkMatches(result.matches);
  if (result.matches.length === 0) throw safeError();
  const matches: RedactionMatch[] = [];
  const rendered: string[] = [];
  let previousEnd = 0, renderedBytes = 0;
  for (const match of result.matches) {
    checkMatch(match, previousEnd);
    if (match.end > input.length || !scalarBoundary(input, match.start) || !scalarBoundary(input, match.end)) throw safeError();
    const unchanged = input.slice(previousEnd, match.start);
    renderedBytes += Buffer.byteLength(unchanged, "utf8") + Buffer.byteLength(match.replacement, "utf8");
    if (renderedBytes > MAX_OUTPUT_BYTES) throw safeError();
    rendered.push(unchanged, match.replacement);
    matches.push({ start: match.start, end: match.end, replacement: match.replacement, kind: match.kind });
    previousEnd = match.end;
  }
  const tail = input.slice(previousEnd);
  if (renderedBytes + Buffer.byteLength(tail, "utf8") > MAX_OUTPUT_BYTES) throw safeError();
  rendered.push(tail);
  if (rendered.join("") !== result.text) throw safeError();
  return { text: result.text, matches };
}

/** Legacy JSON keeps byte-boundary mapping and exact reconstruction checks. */
export function convertNativeResult(input: string, json: string): RedactionResult {
  try {
    checkString(input, MAX_INPUT_BYTES);
    checkString(json, MAX_OUTPUT_BYTES);
    const result = JSON.parse(json);
    if (!result || typeof result !== "object") throw safeError();
    checkString(result.text, MAX_OUTPUT_BYTES);
    checkMatches(result.matches);
    if (result.matches.length === 0) {
      if (result.text !== input) throw safeError();
      return { text: input, matches: [] };
    }
    let byte = 0, utf16 = 0, previousEnd = 0, renderedBytes = 0;
    function index(target: number): number {
      if (!Number.isSafeInteger(target) || target < byte) throw safeError();
      while (byte < target && utf16 < input.length) {
        const cp = input.codePointAt(utf16)!;
        byte += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
        utf16 += cp > 0xffff ? 2 : 1;
      }
      if (byte !== target) throw safeError();
      return utf16;
    }
    const matches: RedactionMatch[] = [];
    const rendered: string[] = [];
    for (const match of result.matches) {
      checkMatch(match, previousEnd);
      const start = index(match.start), end = index(match.end);
      const unchanged = input.slice(matches.at(-1)?.end ?? 0, start);
      renderedBytes += Buffer.byteLength(unchanged, "utf8") + Buffer.byteLength(match.replacement, "utf8");
      if (renderedBytes > MAX_OUTPUT_BYTES) throw safeError();
      rendered.push(unchanged, match.replacement);
      matches.push({ start, end, replacement: match.replacement, kind: match.kind });
      previousEnd = match.end;
    }
    const tail = input.slice(matches.at(-1)?.end ?? 0);
    if (renderedBytes + Buffer.byteLength(tail, "utf8") > MAX_OUTPUT_BYTES) throw safeError();
    rendered.push(tail);
    if (rendered.join("") !== result.text) throw safeError();
    return { text: result.text, matches };
  } catch { throw safeError(); }
}
export function createNativeRedactor(config: NativeConfig, load: () => NativeModule = () => createRequire(import.meta.url)("../native/redaction.node")): Redactor {
  let native: NativeInstance | undefined;
  let v1 = false;
  let negativeProof: RegExp | undefined;
  function engine(): NativeInstance {
    try {
      if (!native) {
        // Always construct/validate configuration, even when every detector is off.
        // Keep the exact constructor snapshot for proof validation, not mutable caller state.
        const configJson = JSON.stringify({ literals: config.literals, detectors: config.detectors });
        const candidate = new (load().NativeRedactor)(configJson);
        if (typeof candidate.redact !== "function" || typeof candidate.reset !== "function") throw safeError();
        const text = candidate.redactTextV1, spans = candidate.redactSpansUtf16V1;
        if (text === undefined && spans === undefined) v1 = false;
        else if (typeof text === "function" && typeof spans === "function") v1 = true;
        else throw safeError(); // Never silently downgrade a partial/unknown V1 ABI.
        if (v1) {
          const descriptor = candidate.negativeProofAsciiV1;
          if (descriptor !== undefined) {
            if (typeof descriptor !== "function") throw safeError();
            const markers = descriptor.call(candidate);
            if (markers !== null) {
              if (typeof markers !== "string" || markers.length > proofMarkers.size) throw safeError();
              let characterClass = "";
              for (const marker of markers) {
                if (!proofMarkers.has(marker)) throw safeError();
                characterClass += `\\x${marker.charCodeAt(0).toString(16).padStart(2, "0")}`;
              }
              // Literal-bearing engines must not offer a proof, even via a mismatched addon.
              if (Object.keys(JSON.parse(configJson).literals ?? {}).length !== 0) throw safeError();
              negativeProof = new RegExp(`[${characterClass}]`); // Non-global; escaped ASCII data only.
            }
          }
        }
        native = candidate;
      }
      return native;
    } catch { throw safeError(); }
  }
  return {
    redact(text) {
      try {
        checkString(text, MAX_INPUT_BYTES);
        const current = engine();
        // Validated V1 empty/certified fields have no spans/state work and fit fixed
        // output/transport budgets (at most 256 units for descriptor proof).
        if (v1 && (text.length === 0 || (negativeProof && text.length <= MAX_PROOF_UNITS && !negativeProof.test(text)))) return { text, matches: [] };
        return v1 ? convertUtf16Result(text, current.redactSpansUtf16V1!(text)) : convertNativeResult(text, current.redact(text));
      } catch { throw safeError(); }
    },
    redactText(text) {
      try {
        checkString(text, MAX_INPUT_BYTES);
        const current = engine();
        if (!v1) return convertNativeResult(text, current.redact(text)).text;
        if (text.length === 0 || (negativeProof && text.length <= MAX_PROOF_UNITS && !negativeProof.test(text))) return text;
        const result = current.redactTextV1!(text);
        if (result === null) return text;
        // Bundled V1 owns rendering/reconstruction and legacy-equivalent transport accounting.
        // Hooks need no spans; do not re-scan or reconstruct the complete output in JS.
        checkString(result, MAX_OUTPUT_BYTES);
        return result;
      } catch { throw safeError(); }
    },
    reset() {
      try { native?.reset(); } catch { throw safeError(); }
    },
  };
}
