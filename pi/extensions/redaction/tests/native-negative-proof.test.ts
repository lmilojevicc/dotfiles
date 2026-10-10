import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeConfig, RedactionResult } from "../src/contracts.ts";
import type { NativeModule } from "../src/native.ts";
import { createNativeRedactor } from "../src/native.ts";
import { offConfig } from "../src/config.ts";

const unavailable = { message: "Redaction engine unavailable" };
function fixture(options: { descriptor?: unknown; config?: NativeConfig; construct?: (json: string) => void; scan?: (text: string) => RedactionResult | null } = {}) {
  const calls = { constructors: 0, proofs: 0, text: [] as string[], spans: [] as string[], resets: 0 };
  class Engine {
    constructor(json: string) { calls.constructors++; options.construct?.(json); }
    redact(): string { throw new Error("not legacy"); }
    redactTextV1(text: string) { calls.text.push(text); return options.scan?.(text)?.text ?? null; }
    redactSpansUtf16V1(text: string) { calls.spans.push(text); return options.scan?.(text) ?? null; }
    reset() { calls.resets++; }
  }
  if (Object.hasOwn(options, "descriptor")) Object.defineProperty(Engine.prototype, "negativeProofAsciiV1", { value: function(this: Engine) {
    assert.ok(this instanceof Engine, "native method receiver preserved");
    calls.proofs++;
    return options.descriptor;
  } });
  return { calls, bridge: createNativeRedactor(options.config ?? offConfig(), () => ({ NativeRedactor: Engine }) as NativeModule) };
}

test("native-certified short no-marker fields skip both V1 views without reusing results", () => {
  const { bridge, calls } = fixture({ descriptor: "[@0123456789-sgAx" });
  bridge.reset();
  assert.equal(calls.constructors, 0);
  for (const input of ["clean", "plain", "🙂名é e\u0301", "\0\t\n\"\\", "q".repeat(256)]) {
    assert.equal(bridge.redactText!(input), input);
    assert.deepEqual(bridge.redact(input), { text: input, matches: [] });
  }
  const first = bridge.redact("plain"), second = bridge.redact("plain");
  assert.notEqual(first, second);
  assert.notEqual(first.matches, second.matches);
  bridge.reset();
  assert.deepEqual(calls, { constructors: 1, proofs: 1, text: [], spans: [], resets: 1 });
});

test("every certified ASCII marker dispatches, including escaped bracket/dash and repeated calls", () => {
  const markers = "[@0123456789-sgAx";
  const { bridge, calls } = fixture({ descriptor: markers });
  for (const marker of markers) {
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.equal(bridge.redactText!(marker), marker);
      assert.deepEqual(bridge.redact(`🙂${marker}尾`), { text: `🙂${marker}尾`, matches: [] });
    }
  }
  assert.equal(calls.text.length, markers.length * 2);
  assert.equal(calls.spans.length, markers.length * 2);
  assert.equal(calls.proofs, 1);
  const duplicates = fixture({ descriptor: "[[@@--" });
  assert.equal(duplicates.bridge.redactText!("clean"), "clean");
  assert.equal(duplicates.bridge.redactText!("@"), "@");
  assert.equal(duplicates.bridge.redactText!("@"), "@");
  assert.deepEqual(duplicates.calls.text, ["@", "@"], "matcher is non-global");
});

test("proof is limited to 256 UTF16 units; empty descriptor is a certified empty marker set", () => {
  const { bridge, calls } = fixture({ descriptor: "" });
  for (const input of ["", "[EMAIL_0] @ - sgAx 123", "😀".repeat(128)]) assert.equal(bridge.redactText!(input), input);
  const longer = "😀".repeat(128) + "q";
  assert.equal(bridge.redactText!(longer), longer);
  assert.deepEqual(bridge.redact("q".repeat(257)), { text: "q".repeat(257), matches: [] });
  assert.deepEqual(calls.text, [longer]);
  assert.deepEqual(calls.spans, ["q".repeat(257)]);
});

test("absent/null proof preserves old paired V1 dispatch and its malformed/refusal checks", () => {
  for (const options of [{}, { descriptor: null }]) {
    const { bridge, calls } = fixture({ ...options, scan: () => { throw new Error("synthetic native refusal"); } });
    assert.equal(bridge.redactText!(""), "", "existing validated empty route retained");
    assert.throws(() => bridge.redactText!("safe"), unavailable);
    assert.throws(() => bridge.redact("safe"), unavailable);
    assert.deepEqual(calls.text, ["safe"]);
    assert.deepEqual(calls.spans, ["safe"]);
    assert.equal(calls.proofs, Object.hasOwn(options, "descriptor") ? 1 : 0);
  }
  const malformed = fixture({ descriptor: "@", scan: () => ({ text: "\ud800", matches: [] }) });
  assert.throws(() => malformed.bridge.redactText!("@"), unavailable);
  assert.throws(() => malformed.bridge.redact("@"), unavailable);
});

test("wrong-type, non-ASCII, unknown, oversized and throwing descriptors fail before empty/proof returns", () => {
  for (const descriptor of [undefined, false, 1, {}, [], "[".repeat(18), "]", "^", "\\", ".", "(", "é", "\0", "\ud800", "[\n"]) {
    const { bridge, calls } = fixture({ descriptor });
    assert.throws(() => bridge.redactText!(""), unavailable);
    assert.throws(() => bridge.redact("safe"), unavailable);
    assert.deepEqual(calls.text, []);
    assert.deepEqual(calls.spans, []);
  }
  for (const availability of [null, "@", 1, () => { throw new Error("synthetic private descriptor detail"); }, "throwing getter"] as const) {
    class Engine {
      redact(): string { throw new Error("not legacy"); }
      redactTextV1() { assert.fail("descriptor failure must not dispatch"); }
      redactSpansUtf16V1() { assert.fail("descriptor failure must not dispatch"); }
      reset() {}
    }
    Object.defineProperty(Engine.prototype, "negativeProofAsciiV1", availability === "throwing getter" ? { get() { throw new Error("synthetic getter detail"); } } : { value: availability });
    const bridge = createNativeRedactor(offConfig(), () => ({ NativeRedactor: Engine }) as unknown as NativeModule);
    assert.throws(() => bridge.redactText!("safe"), unavailable);
    assert.throws(() => bridge.redact(""), unavailable);
  }
});

test("constructor and paired capability checks precede proof negotiation; legacy ignores it", () => {
  let proofReads = 0, legacy = 0;
  class Legacy {
    redact(text: string) { legacy++; return JSON.stringify({ text, matches: [] }); }
    reset() {}
    get negativeProofAsciiV1(): never { proofReads++; throw new Error("legacy must ignore new ABI"); }
  }
  const old = createNativeRedactor(offConfig(), () => ({ NativeRedactor: Legacy }));
  assert.equal(old.redactText!("safe"), "safe");
  assert.deepEqual(old.redact(""), { text: "", matches: [] });
  assert.equal(legacy, 2);
  assert.equal(proofReads, 0);
  class Partial extends Legacy { redactTextV1() { return null; } }
  const partial = createNativeRedactor(offConfig(), () => ({ NativeRedactor: Partial }));
  assert.throws(() => partial.redactText!("safe"), unavailable);
  assert.equal(proofReads, 0);
  const invalid = fixture({ descriptor: "", construct() { throw new Error("synthetic invalid config"); } });
  assert.throws(() => invalid.bridge.redactText!(""), unavailable);
  assert.equal(invalid.calls.proofs, 0);
});

test("literal engines require null proof, based on exact immutable constructor JSON", () => {
  const config = offConfig(); config.literals = { q: "MASK" };
  const mismatch = fixture({ config, descriptor: "", construct(json) {
    assert.deepEqual(JSON.parse(json).literals, { q: "MASK" });
    config.literals = {}; // The constructor's snapshot, not caller state, decides.
  } });
  assert.throws(() => mismatch.bridge.redactText!("q"), unavailable);
  assert.equal(mismatch.calls.text.length, 0);
  const literal = offConfig(); literal.literals = { q: "MASK" };
  const valid = fixture({ config: literal, descriptor: null, scan: input => input === "q" ? { text: "MASK", matches: [{ start: 0, end: 1, replacement: "MASK", kind: "literal" }] } : null });
  assert.equal(valid.bridge.redactText!("q"), "MASK");
  assert.equal(valid.bridge.redact("q").matches.length, 1);
  const initiallyEmpty = offConfig();
  const immutable = fixture({ config: initiallyEmpty, descriptor: "@", construct(json) {
    assert.deepEqual(JSON.parse(json).literals, {});
    initiallyEmpty.literals = { safe: "MASK" };
  } });
  assert.equal(immutable.bridge.redactText!("safe"), "safe");
  initiallyEmpty.detectors.email = true;
  initiallyEmpty.literals = { plain: "OTHER_MASK" };
  assert.equal(immutable.bridge.redactText!("plain"), "plain");
  assert.equal(immutable.calls.proofs, 1);
  assert.deepEqual(immutable.calls.text, []);
});

test("input types, Unicode and byte limits refuse before any certified proof or state work", () => {
  const { bridge, calls } = fixture({ descriptor: "" });
  let coercions = 0;
  for (const input of ["\ud800", "x\udc00", "\udc00\ud800", null, 0, { toString() { coercions++; return "safe"; } }, "é".repeat(4 * 1024 * 1024) + "x"]) {
    assert.throws(() => bridge.redactText!(input as string), unavailable);
    assert.throws(() => bridge.redact(input as string), unavailable);
  }
  assert.equal(coercions, 0);
  assert.equal(calls.constructors, 0);
  assert.equal(bridge.redactText!("名😀"), "名😀");
  assert.equal(calls.proofs, 1);
  assert.deepEqual(calls.text, []);
});

test("recognized and malformed historical token markers always reach native reservation/refusal", () => {
  let reserved = 0;
  const { bridge, calls } = fixture({ descriptor: "[@", scan(input) {
    if (input === "[EMAIL_7]") { reserved = 7; return null; }
    if (input === "[EMAIL_01]") throw new Error("synthetic numeric refusal");
    if (input === "fresh@example.test") return { text: `[EMAIL_${++reserved}]`, matches: [{ start: 0, end: input.length, replacement: `[EMAIL_${reserved}]`, kind: "email" }] };
    return null;
  } });
  assert.deepEqual(bridge.redact("[EMAIL_7]"), { text: "[EMAIL_7]", matches: [] });
  assert.equal(bridge.redactText!("fresh@example.test"), "[EMAIL_8]");
  assert.throws(() => bridge.redactText!("[EMAIL_01]"), unavailable);
  assert.deepEqual(calls.spans, ["[EMAIL_7]"]);
  assert.deepEqual(calls.text, ["fresh@example.test", "[EMAIL_01]"]);
});
