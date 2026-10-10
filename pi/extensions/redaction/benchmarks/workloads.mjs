// Fixed generation, no PRNG or ambient files. All identities are fictional/reserved.
export const detectorsOff = { email: false, phone: false, apiToken: false, privateKey: false, credentialUrl: false };
export const localPii = { literals: {}, detectors: { ...detectorsOff, email: true, phone: true } };
export const trials = 3;
export const warmup = 20;
export const warmupMs = 50;
export const samples = 21;
export const targetBatchMs = 5;
export const maxBatch = 8192;

export function workloads() {
  const rows = [];
  function make(scope, pattern, size, ruleCount = 0) {
    const literals = Object.fromEntries(Array.from({ length: ruleCount }, (_, i) => [
      `synthetic-secret-${String(i).padStart(6, "0")}-end`, `MASK${String(i).padStart(6, "0")}Z`,
    ]));
    const targets = scope === "pii" ? ["bench@example.com", "+14155550132"] : [Object.keys(literals)[0], Object.keys(literals).at(-1)];
    const clean = pattern === "unicode" ? "🙂 名 café ordinary clean log line\n" : "ordinary clean log line\n";
    const secretLine = `${targets[0]} | ${targets[1]}\n`;
    const chunk = pattern === "clean" ? clean : pattern === "dense" ? secretLine : clean.repeat(40) + secretLine;
    // Sizes are minimum UTF-8 bytes; complete chunks avoid clipped sensitive values/surrogates.
    const repeats = Math.ceil(size / Buffer.byteLength(chunk));
    const text = chunk.repeat(repeats);
    const secrets = pattern === "clean" ? [] : [...new Set(targets)];
    rows.push({ id: `${scope}-${pattern}-${size}-rules${ruleCount}`, scope, pattern, requestedBytes: size,
      bytes: Buffer.byteLength(text), utf16Units: text.length, ruleCount,
      config: scope === "pii" ? localPii : { literals, detectors: detectorsOff }, text, secrets,
      expectedMatches: pattern === "clean" ? 0 : repeats * 2 });
  }
  for (const size of [1024, 16384, 131072]) for (const pattern of ["clean", "sparse", "dense", "unicode"]) make("pii", pattern, size);
  for (const ruleCount of [1, 100, 1000]) for (const pattern of ["clean", "sparse", "dense", "unicode"]) make("literal", pattern, 16384, ruleCount);
  for (const size of [1024, 131072]) for (const pattern of ["clean", "sparse", "dense", "unicode"]) make("literal", pattern, size, 100);
  // The original 32 workloads above, including all twelve shared inputs, are unchanged.
  function add(id, texts, secrets = [], expectedMatches = 0, shape = "text", scope = "pii") {
    const text = texts[0];
    rows.push({ id, scope, pattern: id, requestedBytes: Buffer.byteLength(text),
      bytes: Buffer.byteLength(text), utf16Units: text.length, ruleCount: 0,
      config: localPii, text, texts, secrets, expectedMatches, shape,
      comparisonClass: scope !== "pii" ? "local-only" : text.length === 0 ? "diagnostic-upstream-minLength-bypass" : "shared-pii" });
  }
  for (const text of ["", "a", "okay", "a@example.com", "+14155550132", "a@example.com +14155550132"]) {
    const secrets = ["a@example.com", "+14155550132"].filter(value => text.includes(value));
    add(`pii-short-${Buffer.byteLength(text)}`, [text], secrets, secrets.length);
  }
  for (const size of [1024, 16384, 131072]) {
    const unicode = "🙂 名 café e\u0301 ordinary clean log line\n";
    add(`pii-unicode-clean-${size}`, [unicode.repeat(Math.ceil(size / Buffer.byteLength(unicode)))]);
    // Digits are isolated by non-phone delimiters; no valid email/IP/card/SSN/IBAN.
    const near = "@@@ ::: /// .. 1|2|3|4|5|6|7|8|9|0 [ ] ( ) - +x @no-dot@\n";
    add(`pii-near-match-${size}`, [near.repeat(Math.ceil(size / Buffer.byteLength(near)))]);
    const tokens = "[EMAIL_41] [PHONE_73] [REDACTED:Email] [REDACTED:Phone]\n";
    add(`pii-already-redacted-${size}`, [tokens.repeat(Math.ceil(size / Buffer.byteLength(tokens)))]);
  }
  const mixed = Array.from({ length: 32 }, (_, i) => `🙂 changing${i}@example.com +1415555${String(1000 + i)} changing${i}@example.com\n`);
  add("pii-changing-identities", mixed, [], 3);
  add("pii-multi-text-tool-result", ["ordinary clean log line", "a@example.com", "🙂 +14155550132", "tail"],
    ["a@example.com", "+14155550132"], 2, "multi-text");
  add("pii-nested-structured-local-only", ["a@example.com", "+14155550132"],
    ["a@example.com", "+14155550132"], 2, "nested", "local-structured");
  // Native-owner counterexamples are comparable controls, not exclusions. The first
  // two exactly preserve its unfavorable synthetic microprobe payloads.
  const nativeClean = "🙂 名 café ordinary clean log line\n";
  add("pii-unicode-clean-after-long-ascii", ["ordinary clean log line\n".repeat(5700) + "🙂"]);
  add("pii-unicode-email-only-at-end", [nativeClean.repeat(3300) + "a@b.co"], ["a@b.co"], 1);
  add("pii-unicode-marker-only-at-end", [nativeClean.repeat(3300) + "@"]);
  add("pii-unicode-reserved-token-only-at-end", [nativeClean.repeat(3300) + "[EMAIL_41]"]);
  return rows;
}

export function eventFor(task, index = 0) {
  const texts = task.texts ?? [task.text];
  const content = task.shape === "multi-text" ? texts : [texts[index % texts.length]];
  const event = { toolName: "synthetic_tool", toolCallId: "synthetic-id", input: {},
    content: content.map(text => ({ type: "text", text })), isError: false };
  if (task.shape === "multi-text") {
    event.details = { exitCode: 0, label: "ordinary clean status", rows: [{ count: 2 }] };
    event.structuredContent = { status: "okay", count: 2 };
  }
  if (task.shape === "nested") {
    event.details = { rows: texts.map(text => ({ text })), exitCode: 0 };
    event.structuredContent = { result: { messages: texts } };
  }
  return event;
}
