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

const methods = ["redact", "redactTextV1", "redactSpansUtf16V1"];
const refusal = { message: "Redaction configuration or operation is invalid" };

function legacyToUtf16(input, result) {
  return {
    text: result.text,
    matches: result.matches.map(m => ({ ...m,
      start: Buffer.from(input).subarray(0, m.start).toString("utf8").length,
      end: Buffer.from(input).subarray(0, m.end).toString("utf8").length,
    })),
  };
}

test("paired V1 ABI parity with legacy across all independent detectors and scalar offsets", () => {
  const pieces = ["", "clean🙂é", "123456", "1234567890123456", "é1234567é", "１２３４５６７", "a@b.co", "1234567", "(415)555-0132", "sk-abcdefghijklmnopqrstuvwxyz", "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----", "https://user:pass@example.org/x", "[EMAIL_19] [PHONE_2]", "[EMAIL_1x] [PHONE_]", "hidden", "MASK"];
  for (let mask = 0; mask < 32; mask++) {
    const detectors = Object.fromEntries(["email", "phone", "apiToken", "privateKey", "credentialUrl"].map((k, i) => [k, !!(mask & (1 << i))]));
    const engines = methods.map(() => engine({ hidden: "MASK" }, detectors));
    assert.equal(typeof engines[0].redactTextV1, "function");
    assert.equal(typeof engines[0].redactSpansUtf16V1, "function");
    for (const input of [...pieces, "a@b.co🙂 clean ☃ 1234567", "🙂hidden hidden☃", "a@b.co ".repeat(128)]) {
      const legacy = redact(engines[0], input);
      const text = engines[1].redactTextV1(input);
      const spans = engines[2].redactSpansUtf16V1(input);
      assert.equal(text, legacy.matches.length ? legacy.text : null);
      assert.deepEqual(spans, legacy.matches.length ? legacyToUtf16(input, legacy) : null);
      if (spans) {
        let cursor = 0, output = "";
        for (const m of spans.matches) {
          assert.ok(m.start >= cursor && m.end > m.start);
          assert.ok(input.slice(0, m.start).isWellFormed() && input.slice(m.start, m.end).isWellFormed());
          output += input.slice(cursor, m.start) + m.replacement;
          cursor = m.end;
        }
        assert.equal(output + input.slice(cursor), spans.text);
      }
    }
    engines.forEach(e => e.reset());
    for (const [i, method] of methods.entries()) {
      const value = engines[i][method]("[EMAIL_40] a@b.co");
      if (detectors.email) assert.equal(method === "redact" ? JSON.parse(value).text : method === "redactTextV1" ? value : value.text, "[EMAIL_40] [EMAIL_41]");
    }
  }
});

test("V1 null is a completed scan, never a safety/reservation shortcut", () => {
  for (const method of methods) {
    const e = engine({}, { email: true, phone: true });
    const result = e[method]("🙂[EMAIL_70] [PHONE_99]☃");
    assert.equal(method === "redact" ? JSON.parse(result).matches.length : result, method === "redact" ? 0 : null);
    const changed = e[method]("a@b.co 1234567");
    assert.equal(method === "redact" ? JSON.parse(changed).text : method === "redactTextV1" ? changed : changed.text, "[EMAIL_71] [PHONE_100]");
    for (const token of ["[EMAIL_0]", "[EMAIL_01]", "[EMAIL_18446744073709551616]"]) {
      assert.throws(() => e[method](token), refusal);
    }
    e[method]("[EMAIL_18446744073709551615]");
    assert.throws(() => e[method]("c@d.co"), refusal);
    for (const [literals, input] of [[{ secret: "cretMASK" }, "secretMASK"], [{ secret: "cretMASK", other: "PREFIXse" }, "PREFIXsecretMASK"], [{ secret: "cretMASK" }, "sesecret"], [{ "秘密": "密MASK" }, "🙂秘密MASK☃"]]) {
      assert.throws(() => engine(literals)[method](input), refusal);
    }
    const crossing = engine({ "]!x": "MASKED" }, { email: true });
    assert.throws(() => crossing[method]("a@b.co!x"), refusal);
    const next = crossing[method]("c@d.co");
    assert.equal(method === "redact" ? JSON.parse(next).text : method === "redactTextV1" ? next : next.text, "[EMAIL_1]");
  }
});

test("every direct method rejects every lone-surrogate unit before alias state mutation", () => {
  // All 2048 high/low surrogate units, in every position, with adjacent aliases,
  // a genuine replacement character, and neighboring well-formed pairs.
  for (const method of methods) {
    const e = engine({}, { email: true });
    for (let unit = 0xd800; unit <= 0xdfff; unit++) {
      const lone = String.fromCharCode(unit);
      for (const input of [lone, lone + "abc", "abc" + lone, "a" + lone + "b", "[EMAIL_999]" + lone, "\ufffd" + lone + "🙂", "🙂" + lone + "\ufffd", lone + lone]) {
        assert.equal(input.isWellFormed(), false);
        assert.throws(() => e[method](input), refusal);
      }
    }
    const next = e[method]("a@b.co");
    assert.equal(method === "redact" ? JSON.parse(next).text : method === "redactTextV1" ? next : next.text, "[EMAIL_1]");
    for (const input of ["\ufffd", "🙂\ufffd☃", "\ud800\udc00", "\udbff\udfff", "\ud800\udfff\ufffd", "\0🙂\0", "\ufffd[EMAIL_2]"]) {
      const result = e[method](input);
      assert.equal(method === "redact" ? JSON.parse(result).text : result, method === "redact" ? input : null);
    }
    assert.throws(() => new NativeRedactor('{"literals":{"' + "\ud800" + '":"MASK"}}'), refusal);
  }
});

test("V1 wrong types remain noncoercing and input/candidate/identity limits refuse", () => {
  let coercions = 0;
  const object = { toString() { coercions++; throw Error("synthetic-value"); }, [Symbol.toPrimitive]() { coercions++; throw Error("synthetic-value"); } };
  const e = engine();
  for (const method of methods) {
    for (const value of [undefined, null, 123, 1n, Symbol("synthetic"), object, ["synthetic"], new String("synthetic")]) {
      assert.throws(() => e[method](value), refusal);
    }
    assert.throws(() => e[method]("x".repeat(8 * 1024 * 1024 + 1)), refusal);
    assert.throws(() => engine({ x: "MASK" })[method]("x".repeat(100001)), refusal);
    const identities = engine({}, { email: true });
    const many = Array.from({ length: 10001 }, (_, i) => `p${i}@example.test`).join(" ");
    assert.throws(() => identities[method](many), refusal);
    const next = identities[method]("a@b.co");
    assert.equal(method === "redact" ? JSON.parse(next).text : method === "redactTextV1" ? next : next.text, "[EMAIL_1]");
  }
  assert.equal(coercions, 0);
});

test("V1 methods retain the original/pinned corpus oracle", () => {
  const corpus = require("../../fixtures/corpus.json");
  for (const fixture of corpus.cases) {
    const detectors = { [fixture.category]: true };
    const legacy = redact(engine({}, detectors), fixture.text);
    assert.deepEqual(legacy.matches.map(m => Buffer.from(fixture.text).subarray(m.start, m.end).toString()), fixture.secrets);
    assert.equal(engine({}, detectors).redactTextV1(fixture.text), legacy.matches.length ? legacy.text : null);
    assert.deepEqual(engine({}, detectors).redactSpansUtf16V1(fixture.text), legacy.matches.length ? legacyToUtf16(fixture.text, legacy) : null);
  }
});

test("UTF16 preflight has full-method parity for all toggles, first/last markers and late Unicode", () => {
  const clean = "🙂é 名 café ordinary clean line\n\ufffd\0";
  const inputs = [clean, ...["[", "@", "-", "0", "9", "s", "g", "A", "x"].flatMap(marker => [marker + clean, clean + marker]),
    "a".repeat(63) + "🙂", "a".repeat(62) + "🙂", "a".repeat(64) + "\ufffd",
    "a".repeat(128) + clean, "🙂 a@b.co", "a@b.co 🙂", "🙂 1234567", "1234567 🙂",
    "🙂[EMAIL_73] [PHONE_88]", "🙂[EMAIL_1x] [PHONE_]", "\ud800\udc00", "\udbff\udfff",
  ];
  for (let mask = 0; mask < 32; mask++) {
    const detectors = Object.fromEntries(["email", "phone", "apiToken", "privateKey", "credentialUrl"].map((kind, i) => [kind, !!(mask & (1 << i))]));
    const [legacy, text, spans] = methods.map(() => engine({}, detectors));
    for (const input of inputs) {
      const result = redact(legacy, input);
      assert.equal(text.redactTextV1(input), result.matches.length ? result.text : null);
      assert.deepEqual(spans.redactSpansUtf16V1(input), result.matches.length ? legacyToUtf16(input, result) : null);
    }
  }
  for (const method of methods) {
    const literal = engine({ "é": "MASK" });
    const value = literal[method]("🙂é");
    assert.equal(method === "redact" ? JSON.parse(value).text : method === "redactTextV1" ? value : value.text, "🙂MASK");
  }
});

test("UTF16 preflight and fallback preserve exact UTF8 input bounds and malformed-tail nonmutation", () => {
  const boundary = "é".repeat(4 * 1024 * 1024); // Exactly 8 MiB UTF8, only 4 Mi units.
  for (const method of ["redactTextV1", "redactSpansUtf16V1"]) {
    const e = engine({}, { email: true, phone: true });
    assert.equal(e[method](boundary), null);
    assert.throws(() => e[method](boundary + "é"), refusal);
    assert.throws(() => e[method](boundary + "@"), refusal);
    for (const input of ["🙂@ [EMAIL_999] " + "a".repeat(16384) + "\ud800", "a".repeat(128) + "[EMAIL_999]\udfff", "🙂 clean " + "a".repeat(16384) + "\ud800", "a".repeat(62) + "\ud800"]) {
      assert.throws(() => e[method](input), refusal);
    }
    const result = e[method]("a@b.co");
    assert.equal(method === "redactTextV1" ? result : result.text, "[EMAIL_1]");
  }
});

test("explicit alias parser keeps nested recognition, numeric refusal timing and crossing reservations", () => {
  for (const method of methods) {
    const e = engine({}, { email: true, phone: true });
    const unchanged = "[[EMAIL_2]][EMAIL_999999999999999999999999x][EMAIL_[PHONE_7]]";
    const scanned = e[method](unchanged);
    assert.equal(method === "redact" ? JSON.parse(scanned).text : scanned, method === "redact" ? unchanged : null);
    const result = e[method]("a@b.co 1234567");
    assert.equal(method === "redact" ? JSON.parse(result).text : method === "redactTextV1" ? result : result.text, "[EMAIL_3] [PHONE_8]");
    const pending = engine({}, { email: true });
    assert.throws(() => pending[method]("[EMAIL_99][EMAIL_0]"), refusal);
    assert.equal(redact(pending, "a@b.co").text, "[EMAIL_1]");
    const crossing = engine({ hidden: "abc" }, { email: true });
    assert.throws(() => crossing[method]("[EMAIL_19] z@y.co abc@b.co"), refusal);
    assert.equal(redact(crossing, "z@y.co").text, "[EMAIL_20]");
    for (const [field, label] of [["email", "EMAIL"], ["phone", "PHONE"], ["apiToken", "API_TOKEN"], ["privateKey", "PRIVATE_KEY"], ["credentialUrl", "CREDENTIAL_URL"]]) {
      const active = engine({}, { [field]: true });
      for (const suffix of ["0", "01", "18446744073709551616", "999999999999999999999999999999"]) {
        assert.throws(() => active[method](`[${label}_${suffix}]`), refusal);
        const miss = active[method](`[${label}_${suffix}x]`);
        assert.equal(method === "redact" ? JSON.parse(miss).matches.length : miss, method === "redact" ? 0 : null);
      }
      const inactive = engine();
      const disabled = `[${label}_0]`;
      const value = inactive[method](disabled);
      assert.equal(method === "redact" ? JSON.parse(value).text : value, method === "redact" ? disabled : null);
    }
  }
});

test("optional ASCII descriptor exposes only exact enabled markers and rejects literals", () => {
  const corpus = require("../../fixtures/corpus.json");
  for (let mask = 0; mask < 32; mask++) {
    const detectors = Object.fromEntries(["email", "phone", "apiToken", "privateKey", "credentialUrl"].map((kind, i) => [kind, !!(mask & (1 << i))]));
    const e = engine({}, detectors);
    assert.equal(typeof e.negativeProofAsciiV1, "function");
    const descriptor = e.negativeProofAsciiV1();
    const expected = new Set();
    if (mask) expected.add("[");
    if (mask & (1 | 16)) expected.add("@");
    if (mask & 2) for (const digit of "0123456789") expected.add(digit);
    if (mask & 4) for (const initial of "sgAx") expected.add(initial);
    if (mask & 8) expected.add("-");
    assert.equal(descriptor, [...expected].sort().join(""));
    assert.ok(descriptor.length <= 17 && /^[0-9@\[sgAx-]*$/.test(descriptor));
    const inputs = ["", "okay", "🙂é名\ufffd\0", "[EMAIL_41]", "123456", ...corpus.cases.map(f => f.text), ...Array.from({ length: 128 }, (_, i) => "🙂" + String.fromCharCode(i))];
    for (const input of inputs) {
      if ([...input].some(c => descriptor.includes(c))) continue;
      assert.deepEqual(redact(e, input), { text: input, matches: [] });
    }
    e.reset();
    assert.equal(e.negativeProofAsciiV1(), descriptor);
    assert.equal(engine({ hidden: "MASK" }, detectors).negativeProofAsciiV1(), null);
  }
  const e = engine({}, { email: true });
  for (let i = 0; i < 10; i++) assert.equal(e.negativeProofAsciiV1(), "@[");
  assert.equal(redact(e, "a@b.co").text, "[EMAIL_1]");
});

test("Unicode reserved-only proof preserves method parity, all toggles, marker positions and crossing refusals", () => {
  const pieces = ["[EMAIL_41]", "[PHONE_73]", "[API_TOKEN_12]", "[PRIVATE_KEY_9]", "[CREDENTIAL_URL_5]", "[[EMAIL_4]]", "[EMAIL_[PHONE_7]]", "[EMAIL_0]", "[PHONE_01]", "[EMAIL_18446744073709551616]", "[EMAIL_999999999999999999999999x]", "[EMAIL_123456789012345]", "123[EMAIL_1234567]456", "12345[PHONE_73]67", "@", "s", "g", "A", "x", "-", "123456", "1234567", "a@b.co", "https://user:pass@[EMAIL_41]example.org", "-----BEGIN PRIVATE KEY-----\n[EMAIL_41]\n-----END PRIVATE KEY-----"];
  for (let mask = 0; mask < 32; mask++) {
    const detectors = Object.fromEntries(["email", "phone", "apiToken", "privateKey", "credentialUrl"].map((kind, i) => [kind, !!(mask & (1 << i))]));
    const [legacy, text, spans] = methods.map(() => engine({}, detectors));
    for (const piece of pieces) {
      for (const input of [piece + "🙂é", "🙂" + piece + "☃", "🙂é" + piece]) {
        let result;
        try { result = redact(legacy, input); }
        catch (error) {
          assert.equal(error.message, refusal.message);
          assert.throws(() => text.redactTextV1(input), refusal);
          assert.throws(() => spans.redactSpansUtf16V1(input), refusal);
          continue;
        }
        assert.equal(text.redactTextV1(input), result.matches.length ? result.text : null);
        assert.deepEqual(spans.redactSpansUtf16V1(input), result.matches.length ? legacyToUtf16(input, result) : null);
      }
    }
    // Subsequent allocations expose any proof/core reservation disagreement.
    const follow = "a@b.co 1234567";
    const result = redact(legacy, follow);
    assert.equal(text.redactTextV1(follow), result.matches.length ? result.text : null);
    assert.deepEqual(spans.redactSpansUtf16V1(follow), result.matches.length ? legacyToUtf16(follow, result) : null);
  }
  for (const method of methods) {
    const e = engine({}, { email: true, phone: true });
    e[method]("🙂[EMAIL_41]☃[PHONE_73]");
    assert.equal(redact(e, "a@b.co 1234567").text, "[EMAIL_42] [PHONE_74]");
    e.reset();
    e[method]("🙂[EMAIL_18446744073709551615]");
    assert.throws(() => e[method]("a@b.co"), refusal);
  }
});

test("Unicode reservation proof never commits on parser, malformed Unicode, input or opaque-budget failure", () => {
  for (const method of ["redactTextV1", "redactSpansUtf16V1"]) {
    const e = engine({}, { email: true, phone: true });
    for (const input of ["🙂[EMAIL_41][EMAIL_0]", "🙂[EMAIL_41][EMAIL_18446744073709551616]", "🙂[EMAIL_41]\ud800", "🙂[EMAIL_41]@\udfff", "🙂[EMAIL_41]" + "é".repeat(4 * 1024 * 1024), "🙂" + "[EMAIL_41]".repeat(100001)]) {
      assert.throws(() => e[method](input), refusal);
    }
    assert.equal(redact(e, "a@b.co").text, "[EMAIL_1]");
    const crossing = engine({}, { email: true, credentialUrl: true });
    assert.throws(() => crossing[method]("🙂https://user:pass@[EMAIL_41]example.org"), refusal);
    assert.equal(redact(crossing, "c@d.co").text, "[EMAIL_42]", "full fallback reserves valid IDs before later candidate refusal");
  }
});
