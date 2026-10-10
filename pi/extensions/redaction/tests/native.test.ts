import assert from "node:assert/strict";
import { test } from "node:test";
import { convertNativeResult, createNativeRedactor } from "../src/native.ts";
import { offConfig } from "../src/config.ts";

test("native bridge loads once lazily, strips source flags and censors every error", () => {
  let loads = 0, resets = 0;
  const bridge = createNativeRedactor(offConfig(), () => {
    loads++;
    return { NativeRedactor: class {
      constructor(json: string) { assert.deepEqual(Object.keys(JSON.parse(json)).sort(), ["detectors", "literals"]); }
      redact(text: string) { return JSON.stringify({ text, matches: [] }); }
      reset() { resets++; }
    } };
  });
  bridge.reset();
  assert.equal(loads, 0);
  assert.deepEqual(bridge.redact("short"), { text: "short", matches: [] });
  bridge.redact("second");
  bridge.reset();
  assert.equal(loads, 1);
  assert.equal(resets, 1);
  const broken = createNativeRedactor(offConfig(), () => { throw new Error("synthetic raw data"); });
  assert.throws(() => broken.redact("input"), { message: "Redaction engine unavailable" });
});
test("UTF-8 offsets map to UTF-16 in ordered single scan, including emoji and combining marks", () => {
  const input = "😀éone e\u0301two 尾";
  const result = convertNativeResult(input, JSON.stringify({ text: "😀éA e\u0301B 尾", matches: [
    { start: 6, end: 9, replacement: "A", kind: "literal" },
    { start: 13, end: 16, replacement: "B", kind: "email" },
  ] }));
  assert.deepEqual(result.matches.map(({ start, end }) => [start, end]), [[3, 6], [9, 12]]);
});
test("bridge refuses malformed, overlapping, non-boundary, invented output and lone-surrogate data", () => {
  for (const match of [
    { start: 1, end: 4, replacement: "X", kind: "literal" },
    { start: 0, end: 8, replacement: "X", kind: "literal" },
    { start: 0, end: 4, replacement: "X", kind: "unknown" },
    { start: 0, end: 4, replacement: "", kind: "literal" },
  ]) assert.throws(() => convertNativeResult("😀a", JSON.stringify({ text: "Xa", matches: [match] })), { message: "Redaction engine unavailable" });
  assert.throws(() => convertNativeResult("abc", JSON.stringify({ text: "invented", matches: [] })));
  assert.throws(() => convertNativeResult("abc", JSON.stringify({ text: "XX", matches: [{ start: 0, end: 2, replacement: "X", kind: "literal" }, { start: 1, end: 3, replacement: "X", kind: "literal" }] })));
  assert.throws(() => convertNativeResult("\ud800", JSON.stringify({ text: "\ud800", matches: [] })));
  assert.throws(() => convertNativeResult("input", "synthetic raw engine error"), { message: "Redaction engine unavailable" });
});
test("legacy validation rejects malformed output/replacements and excessive span counts", () => {
  for (const result of [
    null, { text: "\ud800", matches: [] },
    { text: "\ud800", matches: [{ start: 0, end: 1, replacement: "\ud800", kind: "literal" }] },
    { text: "X", matches: new Array(100_001).fill({ start: 0, end: 1, replacement: "X", kind: "literal" }) },
  ]) assert.throws(() => convertNativeResult("x", JSON.stringify(result)), { message: "Redaction engine unavailable" });
});

test("legacy input and serialized response caps remain enforced on no-match scans", () => {
  let calls = 0;
  const bridge = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
    redact(text: string) { calls++; return JSON.stringify({ text, matches: [] }); }
    reset() {}
  } }));
  const input = "x".repeat(8 * 1024 * 1024);
  assert.equal(bridge.redactText!(input), input);
  assert.throws(() => bridge.redactText!(input + "x"), { message: "Redaction engine unavailable" });
  assert.throws(() => bridge.redact("\ud800"), { message: "Redaction engine unavailable" });
  assert.equal(calls, 1);
  assert.throws(() => convertNativeResult("x", " ".repeat(64 * 1024 * 1024 + 1)), { message: "Redaction engine unavailable" });
});

test("large Unicode dense spans have correct indices without prefix slicing", () => {
  const count = 10000;
  const input = "😀x".repeat(count);
  const matches = Array.from({ length: count }, (_, i) => ({ start: i * 5 + 4, end: i * 5 + 5, replacement: "Z", kind: "literal" }));
  const result = convertNativeResult(input, JSON.stringify({ text: "😀Z".repeat(count), matches }));
  assert.equal(result.matches.at(-1)?.start, count * 3 - 1);
});
