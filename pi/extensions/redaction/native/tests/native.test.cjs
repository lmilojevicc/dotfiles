const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NativeRedactor } = require("../redaction.node");

function engine(literals = {}, detectors = {}) {
  return new NativeRedactor(JSON.stringify({ literals, detectors }));
}
const redact = (engine, text) => JSON.parse(engine.redact(text));

test("exact export, default off, original UTF-8 offsets and embedded filename", () => {
  assert.equal(typeof NativeRedactor, "function");
  assert.deepEqual(redact(engine(), "a@b.co"), { text: "a@b.co", matches: [] });
  const e = engine({ "xy": "HIDDEN" });
  assert.deepEqual(redact(e, "🙂some-xy.json"), {
    text: "🙂some-HIDDEN.json",
    matches: [{ start: 9, end: 11, replacement: "HIDDEN", kind: "literal" }],
  });
  assert.deepEqual(redact(e, "HIDDEN"), { text: "HIDDEN", matches: [] });
});

test("automatic session identities, reset, idempotence and individual opt-ins", () => {
  const e = engine({}, { email: true });
  assert.equal(redact(e, "a@b.co c@d.co a@b.co").text, "[EMAIL_1] [EMAIL_2] [EMAIL_1]");
  assert.equal(redact(e, "c@d.co").text, "[EMAIL_2]");
  assert.equal(redact(e, "+1 (415) 555-2671").text, "+1 (415) 555-2671");
  assert.equal(e.reset(), undefined);
  assert.equal(redact(e, "c@d.co").text, "[EMAIL_1]");
  assert.deepEqual(redact(e, "🙂[EMAIL_1]☃"), { text: "🙂[EMAIL_1]☃", matches: [] });
  for (const [field, input] of [
    ["phone", "1234567"],
    ["apiToken", "sk-abcdefghijklmnopqrstuvwxyz"],
    ["privateKey", "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----"],
    ["credentialUrl", "https://user:pass@example.org/x"],
  ]) {
    const result = redact(engine({}, { [field]: true }), input);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].kind, field);
    assert.equal(result.matches[0].start, 0);
    assert.equal(result.matches[0].end, Buffer.byteLength(input));
  }
});

test("configuration failures are sanitized, including short literal alias leakage", () => {
  for (const config of [
    "synthetic-secret malformed json",
    JSON.stringify({ literals: { "synthetic-secret": "" } }),
    JSON.stringify({ literals: { "synthetic-secret": "SAME", "other": "SAME" } }),
    JSON.stringify({ literals: { "E": "SAFE" }, detectors: { email: true } }),
    JSON.stringify({ literals: { "synthetic-secret": "[EMAIL_1]" } }),
    JSON.stringify({ detectors: { email: "synthetic-secret" } }),
  ]) {
    assert.throws(() => new NativeRedactor(config), (error) => {
      assert.equal(error.message, "Redaction configuration or operation is invalid");
      assert.doesNotMatch(error.message, /synthetic-secret/);
      return true;
    });
  }
});

test("ambiguous overlap failures are sanitized and do not consume automatic IDs", () => {
  const e = engine({ hidden: "abc" }, { email: true });
  assert.throws(() => e.redact("z@y.co abc@b.co"), {
    message: "Redaction configuration or operation is invalid",
  });
  assert.equal(redact(e, "z@y.co").text, "[EMAIL_1]");
  const pem = "-----BEGIN PRIVATE KEY-----\nYWJj[EMAIL_1]ZA==\n-----END PRIVATE KEY-----";
  assert.throws(() => engine({}, { email: true, privateKey: true }).redact(pem), {
    message: "Redaction configuration or operation is invalid",
  });
});

test("wrong-typed N-API arguments never stringify private objects or invoke coercion", () => {
  let coerced = false;
  const object = { secret: "synthetic-private-value", toString() { coerced = true; throw new Error("synthetic-private-value"); } };
  const e = engine();
  for (const value of [undefined, null, 123, object, ["synthetic-private-value"]]) {
    for (const invoke of [() => new NativeRedactor(value), () => e.redact(value)]) {
      assert.throws(invoke, { message: "Redaction configuration or operation is invalid" });
    }
  }
  assert.equal(coerced, false);
});

test("fresh and reset engines reserve historical IDs without changing known identities", () => {
  const e = engine({}, { email: true });
  assert.equal(redact(e, "[EMAIL_1] a@b.co").text, "[EMAIL_1] [EMAIL_2]");
  assert.equal(redact(e, "[EMAIL_10] a@b.co c@d.co").text, "[EMAIL_10] [EMAIL_2] [EMAIL_11]");
  e.reset();
  assert.equal(redact(e, "[EMAIL_2] [EMAIL_11] e@f.co").text, "[EMAIL_2] [EMAIL_11] [EMAIL_12]");
  assert.deepEqual(redact(e, "[EMAIL_2] [EMAIL_11] [EMAIL_12]"), {
    text: "[EMAIL_2] [EMAIL_11] [EMAIL_12]", matches: [],
  });
});

test("historical numeric tokens safely refuse invalid or exhausted IDs", () => {
  const e = engine({}, { email: true });
  for (const text of ["[EMAIL_0]", "[EMAIL_01]", "[EMAIL_18446744073709551616]", "[EMAIL_9999999999999999999999999999999]"]) {
    assert.throws(() => e.redact(text), { message: "Redaction configuration or operation is invalid" });
  }
  assert.equal(redact(e, "[EMAIL_18446744073709551615]").text, "[EMAIL_18446744073709551615]");
  assert.throws(() => e.redact("a@b.co"), { message: "Redaction configuration or operation is invalid" });
});

test("parenthesized phones allow no-space and spaced formats without relaxing boundaries", () => {
  for (const number of ["(415)555-0132", "(415) 555-0132", "+1 (415)555-0132"]) {
    for (const [prefix, suffix] of [["_: ", "!"], ["🙂「", "」☃"]]) {
      const input = prefix + number + suffix;
      assert.deepEqual(redact(engine(), input), { text: input, matches: [] });
      const e = engine({}, { phone: true });
      const result = redact(e, input);
      assert.deepEqual(result, {
        text: prefix + "[PHONE_1]" + suffix,
        matches: [{ start: Buffer.byteLength(prefix), end: Buffer.byteLength(prefix + number), replacement: "[PHONE_1]", kind: "phone" }],
      });
      assert.deepEqual(redact(e, result.text), { text: result.text, matches: [] });
    }
  }
  for (const input of ["415555-0132", "(415555-0132", "(415)55-0132", "(415)555-01323", "x(415)555-0132", "(415)555-0132x", "é(415)555-0132", "(415)555-0132é"]) {
    assert.deepEqual(redact(engine({}, { phone: true }), input), { text: input, matches: [] });
  }
});

test("literal crossings cannot be hidden by opaque aliases or overlapping selection", () => {
  const cases = [
    [{ secret: "cretMASK" }, "secretMASK"],
    [{ secret: "MASKse" }, "MASKsecret"],
    [{ "秘密": "密MASK" }, "🙂秘密MASK☃"],
    [{ "秘密": "MASK秘" }, "🙂MASK秘密☃"],
    [{ se: "SHORT", secret: "cretMASK" }, "asecretMASK"],
    [{ ase: "LONG", secret: "cretMASK" }, "asecretMASK"],
    [{ secret: "cretMASK", other: "PREFIXse" }, "PREFIXsecretMASK"],
    [{ secret: "ecretMASK", other: "PREFIXse" }, "PREFIXsecretMASK"],
  ];
  for (const [literals, input] of cases) {
    assert.throws(() => engine(literals).redact(input), {
      message: "Redaction configuration or operation is invalid",
    });
  }
});

test("ordinary repeated configured aliases remain opaque and idempotent", () => {
  const e = engine({ secret: "cretMASK", other: "PREFIXse" });
  for (const input of ["cretMASK", "🙂cretMASK cretMASK☃ PREFIXse", "cretMASKPREFIXse"]) {
    assert.deepEqual(redact(e, input), { text: input, matches: [] });
  }
  const result = redact(e, "<secret> cretMASK secret");
  assert.equal(result.text, "<cretMASK> cretMASK cretMASK");
  assert.equal(result.matches.length, 2);
  assert.deepEqual(redact(e, result.text), { text: result.text, matches: [] });
});

test("post-render source reconstruction refuses rather than cascading or committing aliases", () => {
  for (const [literals, input] of [
    [{ secret: "cretMASK" }, "sesecret"],
    [{ secret: "MASKse" }, "secretcret"],
    [{ "秘密": "密MASK" }, "🙂秘秘密☃"],
    [{ "秘密": "MASK秘" }, "🙂秘密密☃"],
  ]) {
    assert.throws(() => engine(literals).redact(input), {
      message: "Redaction configuration or operation is invalid",
    });
  }
  const e = engine({ "]!x": "MASKED" }, { email: true });
  assert.throws(() => e.redact("a@b.co!x"), {
    message: "Redaction configuration or operation is invalid",
  });
  assert.equal(redact(e, "c@d.co").text, "[EMAIL_1]");
});
