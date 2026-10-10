# Native redaction engine

MIT-licensed local Rust core; optional N-API wrapper. `Cargo.lock` pins the entire dependency tree. No network secret validation, subprocess scans, or private configuration reads. The caller supplies JSON explicitly. All detectors and an omitted literal dictionary default off; unknown fields, wrong types and duplicate JSON keys are refused. This engine does not choose which Pi sources are filtered.

## Build and load

From the repository root, with Rust/cargo and Node installed:

```sh
node pi/extensions/redaction/scripts/build-native.mjs
node --test pi/extensions/redaction/native/tests/native.test.cjs
cargo test --locked --manifest-path pi/extensions/redaction/native/Cargo.toml
cargo run --locked --release --manifest-path pi/extensions/redaction/native/Cargo.toml --bin core-benchmark
```

The dependency-free build script selects the Rust host target, builds `--locked --release --features node --lib`, and copies the library to `native/redaction.node`. Both that artifact and `native/target/` are ignored; neither belongs in a source handoff. Build/test currently exercised on macOS arm64; Linux/Windows copy filenames are implemented but not tested here. N-API v6 is requested. The bundled bridge requires Node >=22.18; this native implementation targets Node's V8-backed N-API, tested here on Node 26.10.0. Alternate runtimes (including Bun) are not supported by the Unicode validation assumption below. The core builds without `node` by default. Rebuild `native/redaction.node` after updating source to expose the paired V1 capability; do not distribute generated binaries.

```js
const { NativeRedactor } = require("./native/redaction.node");
const engine = new NativeRedactor(JSON.stringify({
  literals: { "synthetic-person": "PERSON" },
  detectors: { email: true, phone: false, apiToken: false,
    privateKey: false, credentialUrl: false },
}));
const result = JSON.parse(engine.redact("synthetic-person a@example.test"));
engine.reset(); // Clears automatic identities/counters, retains compiled rules.
```

The class remains `NativeRedactor`: constructor `(configJson: string)`, synchronous legacy `redact(text: string): string` (JSON), and `reset(): void`. JSON is `{text, matches:[{start,end,replacement,kind}]}`; `kind` is `literal`, `email`, `phone`, `apiToken`, `privateKey`, or `credentialUrl`. Legacy offsets remain **original-input UTF-8 bytes**, not UTF-16 or output offsets.

The paired synchronous V1 methods are:

```ts
redactTextV1(text: string): string | null;
redactSpansUtf16V1(text: string): {
  text: string;
  matches: Array<{ start: number; end: number; replacement: string;
    kind: "literal" | "email" | "phone" | "apiToken" | "privateKey" | "credentialUrl" }>;
} | null;
```

V1 structured offsets are original-input **JS UTF-16 units**, positive-length, sorted/disjoint, and scalar-aligned. `null` means a completed successful scan with zero replacement spans, not an unchecked lexical shortcut. It still checks input/output/transport budgets, malformed Unicode, historical reservation and literal safety. Non-null text and structured results use the same original-input renderer as legacy. The bridge must select V1 only when both methods exist; old binaries retain the legacy route. No reverse-map API is exported. Errors have a fixed, value-free message; wrong-typed arguments never invoke coercion.

The bundled addon also exposes optional `negativeProofAsciiV1(): string | null`. Any literal rule or nondefault internal budget returns `null`; literal-empty/all-off returns `""`. Otherwise the string is the ASCII marker set derived from enabled scanners: `[` for any automatic detector, `@` for email/credential URLs, all ten digits for phones, `-` for PEM, and `s`, `g`, `A`, `x` for every API-token alternative. No source/replacement values are exposed. With valid configuration, well-formed in-budget input and NONE of those markers, the engine certifies unchanged text, zero spans and no required state work under the current default limits. A bridge may use this optional capability only after validating the paired V1 ABI and descriptor, and must still apply Unicode/type/input/history/failure checks. Missing capability keeps normal dispatch; `null` disables it. This is a per-configuration certificate, never a repeated-input/result cache; detector grammar changes must update or disable the proof.

For literal-free V1 calls, a bounded 63-unit UTF-16 stack sample selects a representation: sampled non-ASCII chooses a full bounded UTF-16 proof scan, while other inputs take the ordinary full UTF-8 route. The sample never proves a result; late Unicode and unsuccessful proofs still receive full scanning. The full proof validates complete surrogate structure and exact UTF-8/rendered/legacy-JSON byte budgets. It can parse complete enabled automatic tokens and stage their checked IDs without full UTF-8 conversion. Unknown, nested or disabled bracket forms conservatively fall back. Email/phone/API candidates cannot cross the complete tokens' `[`/`]` boundaries; their markers inside those tokens are therefore opaque. PEM `-` or credential/email `@` OUTSIDE tokens still forces full scanning, as do API initials `s`, `g`, `A`, `x` outside tokens. Fewer than seven ASCII digits outside complete tokens proves no outside phone candidate. Nothing skips a larger PEM/URL candidate spanning a token.

Staged historical reservations commit only after complete Unicode/input/parser validation and a successful negative proof, before rendered/transport limits: they survive later output refusal exactly like the full core. Parser/Unicode/input/opaque-span failure commits nothing. A failed proof never commits state; the full route owns all work. Literal-free proofs require no literal-boundary/reconstruction work. There is no hit cache. This optimization can add an extra validation scan to Unicode candidates with late outside markers.

Ordinary native argument extraction keeps and borrows N-API UTF-8 storage without a second owned copy. To reject malformed UTF-16 before state mutation without routinely allocating a second Unicode buffer, an `EF BF BD` (U+FFFD) presence search gates bounded explicit UTF-16 surrogate validation. Genuine U+FFFD remains valid. The gate relies on Node's N-API UTF-8 writer replacing **every orphan surrogate** with the Unicode replacement character (invalid UTF-8 is independently rejected). Source evidence:

- [Node v22.18.0 `src/js_native_api_v8.cc`](https://github.com/nodejs/node/blob/v22.18.0/src/js_native_api_v8.cc): `napi_get_value_string_utf8` calls `WriteUtf8` with `REPLACE_INVALID_UTF8 | NO_NULL_TERMINATION`.
- [v22.18.0 V8 `v8-primitive.h`](https://github.com/nodejs/node/blob/v22.18.0/deps/v8/include/v8-primitive.h): `REPLACE_INVALID_UTF8` explicitly replaces orphan surrogate code units with the Unicode replacement character.
- [Node v26.10.0 `src/js_native_api_v8.cc`](https://github.com/nodejs/node/blob/v26.10.0/src/js_native_api_v8.cc) and [V8 header](https://github.com/nodejs/node/blob/v26.10.0/deps/v8/include/v8-primitive.h): equivalent `WriteUtf8V2` / `kReplaceInvalidUtf8` flag and guarantee.

Direct-addon tests enumerate all 2,048 surrogate units in eight malformed contexts per method, plus valid pairs, embedded NULs and valid replacement characters; refusals do not reserve IDs or commit identities. This is not a claim about other N-API implementations.

## Semantics and reserved tokens

Exact sources are case-sensitive literal substrings, including short values and embedded filenames. Aho-Corasick chooses leftmost-longest literal matches. Rendering is one pass from the original input, so replacements are never cascaded. Replacement aliases must be nonempty, unique and mutually non-containing. Sources must be nonempty and may neither contain nor occur inside any configured replacement alias; this rejects cycles and ambiguous replacement/source collisions.

Automatic aliases are `[EMAIL_n]`, `[PHONE_n]`, `[API_TOKEN_n]`, `[PRIVATE_KEY_n]`, and `[CREDENTIAL_URL_n]`, with positive decimal `n` and no leading zero. Identities are exact raw strings within each category, stable until reset; distinct identities get distinct aliases. Configured aliases containing any complete automatic token are refused. For **enabled** detectors, sources and configured aliases that are substrings of *any possible token in that family*, or contain a complete token, are refused at construction. For example literal `E` is incompatible with email detection and literal `1` is incompatible with every automatic detector, while `E` remains valid in literal-only mode. This is intentionally conservative to prevent generated aliases leaking configured sensitive literals, even at future counter values.

Complete configured aliases and enabled automatic-token formats are opaque/protected wherever they appear, including after reset. Before allocating a new identity, the engine reserves every observed ID by advancing that category's counter past the maximum seen. A fresh/reset scan of `[EMAIL_1] new@example.test` therefore emits `[EMAIL_1] [EMAIL_2]`, not two unrelated `[EMAIL_1]` values. Previously issued identities retain their aliases, even when larger historical IDs appear. Valid observed reservations survive later scan refusal. Positive IDs must fit `u64`; zero, leading-zero, overlong and out-of-range numeric tokens for enabled families fail generically. Native finds `[` with memchr and explicitly recognizes enabled prefixes plus one or more ASCII digits and `]`, exactly the previous regex language. Numeric refusal occurs only after a complete token is recognized: `[EMAIL_000x]` is a near miss, while `[EMAIL_000]` refuses when enabled. Searching every opening bracket retains nested tokens such as `[EMAIL_[PHONE_7]]`. The old capture-based regex parser remains a test-only oracle; range, error and full-result/state parity are exercised across all enabled combinations, nested/malformed inputs and span budgets. `u64::MAX` can remain opaque, but exhausts new identities in its category. Configured aliases containing reserved-looking numeric tokens, and enabled literal sources containing them, are also refused.

This makes already-redacted text idempotent but does **not** authenticate raw text as an engine-issued alias. Callers must reject ambiguous original-file alias collisions before round trips; no global reverse substitution is safe. Choose unmistakable configured aliases rather than ordinary words. Explicit reset starts a new identity epoch and clears private mappings/counters; if historical context is retained, feed its prior tokens back through the engine before assigning new values.

Every overlapping literal occurrence is checked on the original input when opaque aliases are present. A literal crossing an alias boundary is refused, including sources spanning adjacent/overlapping complete aliases; merged opaque ranges must not hide it. Leftmost-longest selection still governs noncrossing replacements. A bounded post-render literal check also refuses output that reconstructs a configured source across replacement/surrounding-text boundaries, without cascading replacements or committing new automatic identities.

Literal matches take priority when they cover the entire automatic candidate. Partial literal coverage of an automatic candidate is refused instead of exposing its remainder. Likewise, an automatic candidate crossing a protected alias is refused (a candidate fully contained in opaque aliases is ignored). Crossing automatic candidates that cannot be safely covered by the selected span are refused. These scan errors occur before new aliases are allocated. This includes a complete PEM key containing a reserved token in its body. Unrelated text is preserved on successful scans.

## Resource limits

Fixed, non-configurable limits fail with the same value-free error; there is no eviction or silent identity reuse:

| Budget | Maximum |
| --- | ---: |
| Configuration JSON UTF-8 bytes | 4 MiB |
| Literal rules | 10,000 |
| Combined literal-source + replacement UTF-8 bytes | 1 MiB |
| Input UTF-8 bytes per call | 8 MiB |
| Matches / internal candidates / original-input literal safety occurrences / opaque spans / PEM end positions | 100,000 each |
| Distinct stored automatic identities across all categories | 10,000 |
| Stored raw-identity + alias UTF-8 bytes | 16 MiB |
| Rendered output UTF-8 bytes | 64 MiB |
| N-API legacy or V1 legacy-equivalent JSON bytes, including escaping/metadata | 64 MiB |

Check configuration sizes before parsing/scanning; the ordinary N-API path checks UTF-8 lengths before extracting arguments. The UTF-16 proof path first bounds units to the 8 MiB input-byte cap (a necessary lower bound), allowing at most 16 MiB plus a terminator for the UTF-16 buffer. It then computes exact UTF-8 size and refuses over-cap text before a result or state mutation. This bounded representation scan does not truncate inputs or relax the byte cap. Bound span accumulation and output expansion incrementally. New private mappings are staged and committed only after the core result succeeds. A later response limit can refuse without returning content while retaining already-budgeted core identities; it never evicts/reuses them. V1 counts exactly the legacy serialized UTF-8 response (including legacy byte offsets) without allocating JSON: a checked `24 + 6*textBytes + sum(44 + digits(startByte) + digits(endByte) + 6*replacementBytes + kindNameBytes) + max(0,n-1)` upper bound accepts immediately when it fits; otherwise exact serde-compatible escaping/metadata accounting decides, never a conservative refusal. This also applies to `null`. Repeated known identities remain usable at the mapping limit; new identities fail until explicit reset/drop. These are workload budgets, not a strict accounting of allocator/matcher overhead.

The 8 MiB input cap applies even to full-file reads: adapters must fail safely for larger files, **not truncate before redaction**. Limits are tested with private small-limit helpers so boundary regressions do not allocate large fixtures. Limits are not additional public config fields.

## Detector coverage

These opt-in heuristics are not a compliance/anonymization guarantee:

- Email: ASCII local part and dotted domain; no IDN/Unicode address guarantee.
- Phone: contiguous 7–15 digits, plus common grouped international/North-American formats; a parenthesized area code may directly precede the subscriber group (`(415)555-0132`) or use a separator (`(415) 555-0132`). Unparenthesized grouped area codes still require a separator. Surrounding alphanumeric boundaries prevent matching inside longer numbers/identifiers. No universal numbering-plan validation, extensions or every international grouping.
- API token: long `sk-` / `sk-proj-` / `sk-svcacct-`, GitHub `gh[pousr]_` and `github_pat_`, AWS `AKIA`, Google `AIza`, Slack `xox[baprs]-` prefixes. No arbitrary high-entropy strings, JWTs, assignment-value detection, or provider-wide guarantees.
- Private key: complete PEM `PRIVATE KEY` with optional `RSA`, `EC`, `DSA`, `OPENSSH`, `ENCRYPTED` label; matching end label required. Unterminated/non-PEM keys are not detected. End positions are indexed per fixed label to avoid quadratic repeated-header scans.
- Credential URL: scheme URL containing nonempty userinfo followed by `@` and a nonempty destination; replaces the entire URL. No escaped/encoded userinfo parsing or remote checks.

Overlapping automatic candidates use leftmost-longest, then private-key / credential-URL / API-token / email / phone order for equal spans. Required literal matches are never skipped because the overall input is short. Compiled matchers persist per instance; raw automatic identities stay in process memory until reset/drop and are never logged or serialized. The phone regex alone is skipped when compiled/SIMD-backed searches count fewer than seven ASCII digits in the full input, a necessary condition for every accepted phone alternative. Counting stops at seven; alias parsing and literal safety still run. Literals, protected tokens, all other detectors and post-render safety still run. A private test-only reference invocation deliberately disables this prerequisite and uses the old protected-token regex parser. It is compared across all detector toggles, deterministic Unicode/adversarial inputs, resources and the pinned/original corpus. UTF-16 negative proofs and descriptor absence certificates are separately checked against that full reference, all detector toggles and literal configurations, exact serde budgets, reservation/refusal ordering, token positions and crossings, every API-token prefix alternative and complete malformed-surrogate coverage. Unchanged core renderings borrow input internally; the existing public Rust `Engine::redact` still returns owned text.

The synthetic benchmark reports hot Rust core throughput only, with a correctness/idempotence check before timing. It is not a comparison against another engine, an integration benchmark, or a statistically rigorous p50/p95 result. No fixture-generation scripts are shipped.
