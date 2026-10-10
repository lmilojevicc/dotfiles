import { createRequire } from "node:module";
import type { NativeConfig, RedactionMatch, RedactionResult, Redactor } from "./contracts.ts";

interface NativeInstance { redact(text: string): string; reset(): void }
export interface NativeModule { NativeRedactor: new (configJson: string) => NativeInstance }
const kinds = new Set(["literal", "email", "phone", "apiToken", "privateKey", "credentialUrl"]);
const safeError = () => new Error("Redaction engine unavailable");

/** Convert sorted UTF-8 spans in one forward scan; refuse offsets inside a code point. */
export function convertNativeResult(input: string, json: string): RedactionResult {
  try {
    const result = JSON.parse(json);
    if (typeof result.text !== "string" || !Array.isArray(result.matches)) throw safeError();
    let byte = 0, utf16 = 0, previousEnd = 0;
    function index(target: number): number {
      if (!Number.isSafeInteger(target) || target < byte) throw safeError();
      while (byte < target && utf16 < input.length) {
        const cp = input.codePointAt(utf16)!;
        if (cp >= 0xd800 && cp <= 0xdfff) throw safeError();
        byte += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
        utf16 += cp > 0xffff ? 2 : 1;
      }
      if (byte !== target) throw safeError();
      return utf16;
    }
    const matches: RedactionMatch[] = [];
    const rendered: string[] = [];
    for (const match of result.matches) {
      if (!match || !kinds.has(match.kind) || typeof match.replacement !== "string" || !match.replacement || !Number.isSafeInteger(match.start) || !Number.isSafeInteger(match.end) || match.start < previousEnd || match.end <= match.start) throw safeError();
      const start = index(match.start), end = index(match.end);
      rendered.push(input.slice(matches.at(-1)?.end ?? 0, start), match.replacement);
      matches.push({ start, end, replacement: match.replacement, kind: match.kind });
      previousEnd = match.end;
    }
    // Check the remainder for malformed surrogate input too, even with zero matches.
    index(Buffer.byteLength(input, "utf8"));
    rendered.push(input.slice(matches.at(-1)?.end ?? 0));
    if (rendered.join("") !== result.text) throw safeError();
    return { text: result.text, matches };
  } catch { throw safeError(); }
}
export function createNativeRedactor(config: NativeConfig, load: () => NativeModule = () => createRequire(import.meta.url)("../native/redaction.node")): Redactor {
  let native: NativeInstance | undefined;
  function engine(): NativeInstance {
    try {
      native ??= new (load().NativeRedactor)(JSON.stringify({ literals: config.literals, detectors: config.detectors }));
      return native;
    } catch { throw safeError(); }
  }
  return {
    redact(text) {
      try { return convertNativeResult(text, engine().redact(text)); }
      catch { throw safeError(); }
    },
    reset() {
      try { native?.reset(); } catch { throw safeError(); }
    },
  };
}
