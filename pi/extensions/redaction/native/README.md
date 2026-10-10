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

The dependency-free build script selects the Rust host target, builds `--locked --release --features node --lib`, and copies the library to `native/redaction.node`. Both that artifact and `native/target/` are ignored; neither belongs in a source handoff. Build/test currently exercised on macOS arm64; Linux/Windows copy filenames are implemented but not tested here. N-API v6 is requested (Node >=16 is a conservative runtime floor). The core builds without `node` by default.

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

The export is exactly the class `NativeRedactor`: constructor `(configJson: string)`, synchronous `redact(text: string): string` (JSON), and `reset(): void`. JSON is `{text, matches:[{start,end,replacement,kind}]}`; `kind` is `literal`, `email`, `phone`, `apiToken`, `privateKey`, or `credentialUrl`. Offsets are **original-input UTF-8 bytes**, not UTF-16 or output offsets. The JS bridge must convert them before exposing the shared TypeScript `Redactor` seam. No reverse-map API is exported. Errors have a fixed, value-free message.

## Semantics and reserved tokens

Exact sources are case-sensitive literal substrings, including short values and embedded filenames. Aho-Corasick chooses leftmost-longest literal matches. Rendering is one pass from the original input, so replacements are never cascaded. Replacement aliases must be nonempty, unique and mutually non-containing. Sources must be nonempty and may neither contain nor occur inside any configured replacement alias; this rejects cycles and ambiguous replacement/source collisions.

Automatic aliases are `[EMAIL_n]`, `[PHONE_n]`, `[API_TOKEN_n]`, `[PRIVATE_KEY_n]`, and `[CREDENTIAL_URL_n]`, with positive decimal `n` and no leading zero. Identities are exact raw strings within each category, stable until reset; distinct identities get distinct aliases. Configured aliases containing any complete automatic token are refused. For **enabled** detectors, sources and configured aliases that are substrings of *any possible token in that family*, or contain a complete token, are refused at construction. For example literal `E` is incompatible with email detection and literal `1` is incompatible with every automatic detector, while `E` remains valid in literal-only mode. This is intentionally conservative to prevent generated aliases leaking configured sensitive literals, even at future counter values.

Complete configured aliases and enabled automatic-token formats are opaque/protected wherever they appear, including after reset. Before allocating a new identity, the engine reserves every observed ID by advancing that category's counter past the maximum seen. A fresh/reset scan of `[EMAIL_1] new@example.test` therefore emits `[EMAIL_1] [EMAIL_2]`, not two unrelated `[EMAIL_1]` values. Previously issued identities retain their aliases, even when larger historical IDs appear. Valid observed reservations survive later scan refusal. Positive IDs must fit `u64`; zero, leading-zero, overlong and out-of-range numeric tokens for enabled families fail generically. `u64::MAX` can remain opaque, but exhausts new identities in its category. Configured aliases containing reserved-looking numeric tokens, and enabled literal sources containing them, are also refused.

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
| N-API serialized JSON response bytes, including escaping/metadata | 64 MiB |

Check config/input sizes before parsing/scanning; N-API checks UTF-8 lengths before copying arguments. Bound span accumulation and output expansion incrementally. New private mappings are staged and committed only after the core result succeeds. A later JSON-response limit can refuse without returning content while retaining already-budgeted core identities; it never evicts/reuses them. Repeated known identities remain usable at the mapping limit; new identities fail until explicit reset/drop. These are workload budgets, not a strict accounting of allocator/matcher overhead.

The 8 MiB input cap applies even to full-file reads: adapters must fail safely for larger files, **not truncate before redaction**. Limits are tested with private small-limit helpers so boundary regressions do not allocate large fixtures. Limits are not additional public config fields.

## Detector coverage

These opt-in heuristics are not a compliance/anonymization guarantee:

- Email: ASCII local part and dotted domain; no IDN/Unicode address guarantee.
- Phone: contiguous 7–15 digits, plus common grouped international/North-American formats; a parenthesized area code may directly precede the subscriber group (`(415)555-0132`) or use a separator (`(415) 555-0132`). Unparenthesized grouped area codes still require a separator. Surrounding alphanumeric boundaries prevent matching inside longer numbers/identifiers. No universal numbering-plan validation, extensions or every international grouping.
- API token: long `sk-` / `sk-proj-` / `sk-svcacct-`, GitHub `gh[pousr]_` and `github_pat_`, AWS `AKIA`, Google `AIza`, Slack `xox[baprs]-` prefixes. No arbitrary high-entropy strings, JWTs, assignment-value detection, or provider-wide guarantees.
- Private key: complete PEM `PRIVATE KEY` with optional `RSA`, `EC`, `DSA`, `OPENSSH`, `ENCRYPTED` label; matching end label required. Unterminated/non-PEM keys are not detected. End positions are indexed per fixed label to avoid quadratic repeated-header scans.
- Credential URL: scheme URL containing nonempty userinfo followed by `@` and a nonempty destination; replaces the entire URL. No escaped/encoded userinfo parsing or remote checks.

Overlapping automatic candidates use leftmost-longest, then private-key / credential-URL / API-token / email / phone order for equal spans. Required literal matches are never skipped because the overall input is short. Compiled matchers persist per instance; raw automatic identities stay in process memory until reset/drop and are never logged or serialized.

The synthetic benchmark reports hot Rust core throughput only, with a correctness/idempotence check before timing. It is not a comparison against another engine, an integration benchmark, or a statistically rigorous p50/p95 result. No fixture-generation scripts are shipped.
