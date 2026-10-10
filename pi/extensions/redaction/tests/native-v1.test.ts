import assert from "node:assert/strict";
import { test } from "node:test";
import type { RedactionResult } from "../src/contracts.ts";
import type { NativeModule } from "../src/native.ts";
import { createNativeRedactor } from "../src/native.ts";
import { offConfig } from "../src/config.ts";

// Explicit ABI mocks only. Native parity/resource guarantees need the rebuilt bundled addon.
function mock(options: { text?: (text: string) => unknown; spans?: (text: string) => unknown } = {}) {
  const calls = { constructors: 0, text: 0, spans: 0, legacy: 0, resets: 0 };
  const bridge = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
    constructor() { calls.constructors++; }
    redact(): string { calls.legacy++; throw new Error("V1 must not serialize JSON"); }
    redactTextV1(text: string) { calls.text++; return options.text?.(text) ?? null; }
    redactSpansUtf16V1(text: string) { calls.spans++; return options.spans?.(text) ?? null; }
    reset() { calls.resets++; }
  } }) as NativeModule);
  return { bridge, calls };
}
const unavailable = { message: "Redaction engine unavailable" };

test("paired V1 null preserves original clean text with no JSON or span conversion", () => {
  const { bridge, calls } = mock();
  bridge.reset();
  assert.equal(calls.constructors, 0);
  for (const input of ["", "clean ASCII", "🙂e\u0301 名 尾", "[EMAIL_9007199254740993]"]) {
    assert.deepEqual(bridge.redact(input), { text: input, matches: [] });
    assert.equal(bridge.redactText!(input), input);
  }
  bridge.reset();
  assert.deepEqual(calls, { constructors: 1, text: 3, spans: 3, legacy: 0, resets: 1 });
});

test("empty V1 shortcut validates construction/capabilities first, but legacy still dispatches", () => {
  let constructed = 0, dispatched = 0;
  const v1 = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
    constructor(json: string) { constructed++; assert.deepEqual(JSON.parse(json).literals, {}); }
    redact(): string { throw new Error("not legacy"); }
    redactTextV1(): string | null { dispatched++; throw new Error("validated V1 empty invariant is trusted"); }
    redactSpansUtf16V1(): RedactionResult | null { dispatched++; throw new Error("validated V1 empty invariant is trusted"); }
    reset() {}
  } }));
  assert.equal(v1.redactText!(""), "");
  assert.deepEqual(v1.redact(""), { text: "", matches: [] });
  assert.equal(constructed, 1);
  assert.equal(dispatched, 0);
  assert.throws(() => v1.redactText!("x"), unavailable);
  assert.throws(() => v1.redact("😀"), unavailable);
  assert.equal(dispatched, 2, "no broader proof-negative string shortcut");
  const legacy = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
    redact(): string { dispatched++; throw new Error("legacy empty refusal is checked"); }
    reset() {}
  } }));
  assert.throws(() => legacy.redactText!(""), unavailable);
  assert.throws(() => legacy.redact(""), unavailable);
  assert.equal(dispatched, 4);
});

test("tiny field byte-cap proof still refuses malformed input and backend output", () => {
  for (const input of ["x", "😀", "e\u0301"]) {
    const { bridge, calls } = mock({ text: () => "\ud800", spans: () => ({ text: "\ud800", matches: [{ start: 0, end: input.length, replacement: "\ud800", kind: "literal" }] }) });
    assert.throws(() => bridge.redactText!(input), unavailable);
    assert.throws(() => bridge.redact(input), unavailable);
    assert.equal(calls.text, 1);
    assert.equal(calls.spans, 1);
  }
  const { bridge, calls } = mock();
  for (const input of ["\ud800", "x\udc00", "\udc00\ud800"]) {
    assert.throws(() => bridge.redactText!(input), unavailable);
    assert.throws(() => bridge.redact(input), unavailable);
  }
  assert.equal(calls.constructors, 0);
});

test("V1 null never parses JSON or walks Unicode code points in JavaScript", () => {
  const { bridge } = mock();
  bridge.redact("initialize");
  const parse = JSON.parse, codePointAt = String.prototype.codePointAt;
  let result: RedactionResult | undefined, text: string | undefined;
  try {
    JSON.parse = () => { throw new Error("unexpected JSON parsing"); };
    String.prototype.codePointAt = () => { throw new Error("unexpected scalar walk"); };
    result = bridge.redact("🙂名 clean");
    text = bridge.redactText!("🙂名 clean");
  } finally { JSON.parse = parse; String.prototype.codePointAt = codePointAt; }
  assert.deepEqual(result, { text: "🙂名 clean", matches: [] });
  assert.equal(text, "🙂名 clean");
});

test("V1 validates malformed Unicode and argument types before constructing or invoking native", () => {
  const { bridge, calls } = mock();
  let stringifications = 0;
  for (const value of ["\ud800", "tail\udfff", "\ud800x\udc00", 1, null, undefined, { toString() { stringifications++; return "clean"; } }]) {
    assert.throws(() => bridge.redact(value as string), unavailable);
    assert.throws(() => bridge.redactText!(value as string), unavailable);
  }
  assert.equal(calls.constructors, 0);
  assert.equal(stringifications, 0);
  assert.equal(bridge.redactText!("🙂"), "🙂");
  assert.throws(() => bridge.redact("\ud800"), unavailable);
  assert.deepEqual(calls, { constructors: 1, text: 1, spans: 0, legacy: 0, resets: 0 });
});

test("partial, wrong-typed or unknown V1 capabilities fail instead of downgrading", () => {
  for (const methods of [
    { redactTextV1: () => null }, { redactSpansUtf16V1: () => null },
    { redactTextV1: null, redactSpansUtf16V1: null },
    { redactTextV1: "unknown", redactSpansUtf16V1: () => null },
    { redactTextV1: () => null, redactSpansUtf16V1: false },
  ]) {
    let legacy = 0;
    class Candidate {
      redact(text: string) { legacy++; return JSON.stringify({ text, matches: [] }); }
      reset() {}
    }
    Object.assign(Candidate.prototype, methods);
    const bridge = createNativeRedactor(offConfig(), () => ({ NativeRedactor: Candidate }) as NativeModule);
    for (const input of ["", "clean"]) {
      assert.throws(() => bridge.redact(input), unavailable);
      assert.throws(() => bridge.redactText!(input), unavailable);
    }
    assert.equal(legacy, 0);
  }
});

test("all-off does not bypass constructor configuration validation; legacy text fallback stays checked", () => {
  let validations = 0;
  const invalid = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
    constructor() { validations++; throw new Error("synthetic config refusal"); }
    redact() { return ""; }
    reset() {}
  } }));
  for (const input of ["", "clean"]) {
    assert.throws(() => invalid.redactText!(input), unavailable);
    assert.throws(() => invalid.redact(input), unavailable);
  }
  assert.equal(validations, 4);
  for (const text of ["clean", "invented"]) {
    const legacy = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
      redact() { return JSON.stringify({ text, matches: [] }); }
      reset() {}
    } }));
    if (text === "clean") assert.equal(legacy.redactText!("clean"), "clean");
    else assert.throws(() => legacy.redactText!("clean"), unavailable);
  }
});

test("V1 UTF16 spans use original scalar boundaries, reconstruct output and retain replacement counts", () => {
  const input = "😀éone e\u0301two 尾";
  const expected: RedactionResult = { text: "😀éA e\u0301B 尾", matches: [
    { start: 3, end: 6, replacement: "A", kind: "literal" },
    { start: 9, end: 12, replacement: "B", kind: "email" },
  ] };
  const { bridge, calls } = mock({ spans: () => expected, text: () => expected.text });
  const result = bridge.redact(input);
  assert.deepEqual(result, expected);
  assert.notEqual(result.matches, expected.matches);
  assert.equal(bridge.redactText!(input), expected.text);
  assert.deepEqual(calls, { constructors: 1, text: 1, spans: 1, legacy: 0, resets: 0 });
  const unchanged = mock({ spans: () => ({ text: "x", matches: [{ start: 0, end: 1, replacement: "x", kind: "literal" }] }) });
  assert.equal(unchanged.bridge.redact("x").matches.length, 1, "equal output is not a zero-span scan");
});

test("V1 structured data rejects malformed bounds, order, kinds, counts, strings and invented output", () => {
  const valid = { start: 0, end: 2, replacement: "X", kind: "literal" };
  const badResults: unknown[] = [
    undefined, false, "JSON is not V1", {}, { text: "😀a", matches: [] },
    { text: "Xa", matches: null }, { text: "\ud800", matches: [valid] },
    { text: "invented", matches: [valid] },
    ...[
      { ...valid, start: 1 }, { ...valid, end: 1 }, { ...valid, end: 4 },
      { ...valid, start: -1 }, { ...valid, start: 0.5 }, { ...valid, end: Infinity },
      { ...valid, kind: "unknown" }, { ...valid, replacement: "" },
      { ...valid, replacement: "\ud800" }, { ...valid, replacement: 5 },
    ].map(match => ({ text: "Xa", matches: [match] })),
    { text: "XX", matches: [valid, { ...valid, start: 1, end: 3 }] },
    { text: "Xa", matches: new Array(100_001).fill(valid) },
  ];
  for (const result of badResults) {
    // Unlike mock(), this intentionally permits undefined return data.
    const bridge = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
      redact(): string { throw new Error("unexpected legacy"); }
      redactTextV1() { return null; }
      redactSpansUtf16V1() { return result; }
      reset() {}
    } }) as NativeModule);
    assert.throws(() => bridge.redact("😀a"), unavailable);
  }
});

test("text-only V1 checks types, Unicode and refusals while trusting bundled rendering invariants", () => {
  for (const result of [undefined, false, {}, "\udfff"]) {
    const bridge = createNativeRedactor(offConfig(), () => ({ NativeRedactor: class {
      redact(): string { throw new Error("unexpected legacy"); }
      redactSpansUtf16V1() { return null; }
      redactTextV1() { return result; }
      reset() {}
    } }) as unknown as NativeModule);
    assert.throws(() => bridge.redactText!("input"), unavailable);
  }
  for (const route of ["text", "spans"] as const) {
    const { bridge } = mock({ [route]: () => { throw new Error("synthetic private detail"); } });
    assert.throws(() => route === "text" ? bridge.redactText!("input") : bridge.redact("input"), unavailable);
  }
  // An explicit trust-boundary test, not evidence that an arbitrary native addon is safe.
  assert.equal(mock({ text: () => "native-verified rendering" }).bridge.redactText!("input"), "native-verified rendering");
});

test("V1 no-match still checks 8 MiB UTF8 input and 64 MiB output limits", () => {
  const { bridge, calls } = mock();
  const atCap = "x".repeat(8 * 1024 * 1024);
  assert.equal(bridge.redactText!(atCap), atCap);
  assert.equal(bridge.redact(atCap).text, atCap);
  for (const input of [atCap + "x", "é".repeat(4 * 1024 * 1024) + "x", "😀".repeat(2 * 1024 * 1024) + "x"]) {
    assert.throws(() => bridge.redactText!(input), unavailable);
    assert.throws(() => bridge.redact(input), unavailable);
  }
  assert.equal(calls.text, 1);
  assert.equal(calls.spans, 1);
  const triples = "\u0800".repeat(Math.floor(8 * 1024 * 1024 / 3));
  assert.equal(bridge.redactText!(triples + "xx"), triples + "xx", "exact cap at three bytes per code unit");
  assert.throws(() => bridge.redactText!(triples + "xxx"), unavailable);
  const output = "x".repeat(64 * 1024 * 1024);
  assert.equal(mock({ text: () => output }).bridge.redactText!("x"), output);
  const oversized = output + "x";
  assert.throws(() => mock({ text: () => oversized }).bridge.redactText!("x"), unavailable);
  assert.throws(() => mock({ spans: () => ({ text: oversized, matches: [{ start: 0, end: 1, replacement: oversized, kind: "literal" }] }) }).bridge.redact("x"), unavailable);
});

test("V1 handles dense Unicode spans without a UTF8 reverse map", () => {
  const count = 10000;
  const matches = Array.from({ length: count }, (_, i) => ({ start: i * 3 + 2, end: i * 3 + 3, replacement: "Z", kind: "literal" }));
  const { bridge } = mock({ spans: () => ({ text: "😀Z".repeat(count), matches }) });
  const result = bridge.redact("😀x".repeat(count));
  assert.equal(result.matches.length, count);
  assert.equal(result.matches.at(-1)?.start, count * 3 - 1);
});
