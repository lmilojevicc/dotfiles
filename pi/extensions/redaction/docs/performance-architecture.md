# Performance architecture: paired native V1 bridge

Status: paired native V1 and TypeScript bridge integrated, including the bounded second/third-pass native reservation-aware Unicode proof/alias parser and bridge small-field/empty/wrapper/certificate changes. Actual-addon tests cover parity, UTF16 spans, Unicode refusal, reservation, production hook routing, metadata clones and file edits. Independent review and end-to-end performance acceptance remain required. This document supplements `pi-adapter.md`; it does not expand source coverage, filesystem authority or privacy guarantees.

## Routes and compatibility

`NativeRedactor(configJson)`, `redact(text): string` (legacy JSON with original UTF-8 byte offsets), and `reset(): void` remain required. The constructor always receives the complete `{literals,detectors}` and validates configuration, even with all rules off. Inactive extension configuration registers status and the lazy human `/redaction` menu: no engine/file loading or filtering hooks. Menu dependencies remain cold until invocation. Explicit invalid policy still censors requests.

The approved addon exposes both synchronous methods:

```ts
redactTextV1(text: string): string | null;
redactSpansUtf16V1(text: string): {
  text: string;
  matches: Array<{
    start: number; end: number; replacement: string;
    kind: "literal" | "email" | "phone" | "apiToken"
      | "privateKey" | "credentialUrl";
  }>;
} | null;
```

Both capabilities must be functions before either route is selected. Both absent (`undefined`) selects the fully checked legacy route. A partial pair or wrong-typed capability fails with `Redaction engine unavailable`; it does **not** downgrade. Unknown endpoint spellings are not called. This is a versioned, trusted bundled-addon seam, not attestation of an arbitrary third-party addon. Rebuild the native binary when integrating V1; legacy binaries remain compatible but get no native V1 speed benefit.

Shared `Redactor.redactText?(text): string` is optional. Hook sanitizers prefer it and fall back to `redact(text).text` for existing mock/consumer compatibility. Errors never trigger a fallback retry. File consumers continue using the guarded `redact` span seam and their independent validation/budgets. Historical alias reservation also uses spans: successful token reservation must return unchanged text **and zero matches**, not merely unchanged text.

## No-match and trust boundary

`null` means native completed the **entire successful scan with zero replacement spans**. It is not a lexical prerequisite check. Native still owns protected-token recognition, exact numeric-ID validation/reservation, all configured literal safety occurrences, overlap refusal, candidate budgets, post-render literal safety, and both output budgets. Historical reservations can survive later refusals as before. New private identities remain transactional through core rendering/reconstruction checks; later transport refusal may retain already-budgeted core identities, exactly as legacy serialization refusal does.

Before calling either native route, JS checks the argument is a string, `isWellFormed()` and the UTF-8 byte cap. No coercion or object stringification occurs. Well-formed UTF-16 needs at most three UTF-8 bytes per code unit (a surrogate pair uses four bytes for two units), so length ≤ byte-cap/3 proves small fields fit without `Buffer.byteLength`. Longer strings still require exact counting; length > byte-cap always refuses. This byte-budget proof alone does **not** skip detection. The optional native-certified marker-absence route below may separately discharge eligible nonempty fields. A null result returns the original JS string (or `{text: input, matches: []}`) without JSON parsing, scalar iteration, byte-to-UTF16 mapping, slicing or rendered-output reconstruction. The well-formedness intrinsic and, when required, byte counting still scan Unicode/input bytes; this is **not** constant-time detection or zero-copy JS-to-native extraction.

After successful native constructor configuration validation **and complete paired V1 capability validation**, JS may return empty text/zero spans without a native method call. Validated literals have no empty sources; empty input contains no detector candidate, protected token or historical ID and cannot allocate/reserve identities or trigger post-render literal collisions. Fixed default output/transport budgets fit empty output. This narrowly trusted bundled-native invariant does not generalize to arbitrary short strings, legacy ABI or malformed/partial capabilities. Legacy still dispatches even on empty. A synthetic V1 mock's empty scan method may therefore be skipped, but nonempty mock refusals/malformed output remain checked. Hook failure and history guards run before this bridge shortcut; an already-latched hook still censors empty fields.

Non-null structured V1 results use original-input JS UTF-16 offsets. JS validates result shape, output type/well-formedness/byte cap, positive sorted/disjoint safe-integer spans, valid kinds, nonempty well-formed replacements and scalar boundaries (including emoji interiors). It bounds accumulation and reconstructs from original input to verify exact output equality. Non-null structured results must contain matches; equal output can still have a nonzero match count. Returned span objects are copied into the shared seam.

Non-null **text-only** results are checked for string type, well-formedness and rendered-byte cap. JS deliberately does not reconstruct them or rescan detectors: correctness/rendering/reconstruction and legacy-equivalent transport accounting are trusted invariants of the paired bundled native V1 implementation. Arbitrary invented-but-valid text cannot be independently rejected on this route without defeating this contract. Mock tests make that trust explicit; malformed text/types and native refusals still fail safely. Actual-addon integration tests check fresh-engine parity across legacy, text-only, structured and bridge routes.

Legacy JSON retains UTF-8 boundary conversion and exact reconstruction verification for replacements. No-match legacy JSON verifies exact input equality without walking every code point or joining a full rendered copy. The surrogate remainder walk is replaced by the runtime well-formedness intrinsic. Legacy input, output, serialized response and match-count caps are checked, including no-match responses.

## Unchanged safety/resource requirements

| Bridge/native boundary | Limit |
| --- | ---: |
| Input per scan | 8 MiB UTF-8 |
| Rendered output | 64 MiB UTF-8 |
| Replacement spans | 100,000 |
| Legacy-equivalent serialized response | 64 MiB UTF-8 |

The bridge enforces the first three where data is exposed, and legacy serialized JSON size. Native V1 must enforce the last limit **without allocating JSON**, including null scans. The approved accounting fast bound is:

`24 + 6*textBytes + Σ(44 + digits(startByte) + digits(endByte) + 6*replacementBytes + kindNameBytes) + max(0,n-1)`.

Use checked arithmetic and original-input **UTF-8 byte** offsets for legacy parity. If this bound fits, no exact counting pass is needed. Otherwise bounded exact JSON escape/metadata accounting decides; do not conservatively refuse an otherwise valid response. Default 8 MiB zero-span input fits the transport bound, but native small-limit tests must still exercise exact null boundaries. Control characters, quotes, backslashes, Unicode and digit-width transitions require parity with actual legacy serialization.

All existing native configuration/candidate/alias storage limits and file limits remain in force; see `native/README.md` and `file-safety.md`. These are workload/accounted-storage caps, not RSS guarantees. Copies for non-null spans and reconstruction remain transient allocations. There is no repeat-input cache, manually duplicated JS detector regex, blanket unredaction, disabled rule, nonempty minimum-input shortcut or benchmark exclusion.

The hook failure latch, source flags, direct-user exception, structured/details/property-name sanitization, opaque/binary exclusions, history traversal limits and reset semantics are unchanged. Failure returns safe censor replacements rather than swallowed hook throws. Reservation never grants file restoration authority.

## Initial evidence and required integration

Node 26.10.0 mock tests cover null/unchanged identity, absence of JSON/scalar walking on null, malformed Unicode/types before invocation, partial/wrong-typed capabilities, all-off constructor validation, legacy fallback, UTF16 scalar boundaries, invented structured output, equal-output nonzero spans, counts, dense Unicode, input/output caps, fixed errors, history reservations, reset, source-aware hooks, nested tool JSON, file span compatibility and sticky text-only failure. Existing file/history/config tests are retained.

A TEMP mock-only probe (`/tmp/redaction-bridge-check.YMtJVz/probe.mjs`, results `probe.json`) measures production bridge plus synthetic JS ABI mocks: 100 warmups, 31 batches × 30 calls, no cached outputs. ASCII input is 131,072 bytes; Unicode `😀é名` is 131,076 bytes. The legacy mock serializes JSON on every call; V1 mocks return null without doing native scanning. p50 / p95 milliseconds:

| Mock + bridge route | ASCII | Unicode |
| --- | --- | --- |
| Legacy text fallback | .0960 / .1064 | .2509 / .2788 |
| V1 text null | .00636 / .00681 | .01412 / .01516 |
| V1 structured null | .00623 / .00710 | .01410 / .01550 |

This isolates JS mock/representation overhead; **not native measurements, detector throughput, N-API transport cost, or an achieved end-to-end speedup**. It is not a replacement for the approved prior profiling evidence or full benchmark workloads. Constructor cold cost is excluded and all checks remain inside timed calls. The actual addon was absent in that initial bridge-only probe.

The earlier bridge-only validation used ABI mocks and lacked the addon; no native/corpus correctness claim follows from those mocks. Integrated validation rebuilds the bundled addon and runs all Rust, addon and TypeScript tests, including the retained original/pinned corpus and source-only pack contamination regression. `tests/integration-native-v1.test.ts` verifies real null/text/structured/legacy parity, original UTF16 scalar boundaries, malformed surrogates before state mutation/bridge dispatch, exact large-ID reservation, transactional literal-boundary refusal, default production hook text routing without legacy fallback, and guarded file-span editing. Second-pass integration cases add markers at the end, Unicode after long ASCII prefixes, exact input caps, nested/invalid/max alias IDs, validated empty dispatch and fresh metadata clones. Native tests cover exact transport caps and optimized/reference detector parity.

Benchmark acceptance must assert paired V1 use, retain all workloads/config/correctness checks, separate cold/hot and core/N-API/hook costs, and measure p50/p95 without treating missing detections as wins. Independent review and final serial benchmark remain parent-owned.

## Second bounded pass: production small-field/wrapper profiling

The second pass does not change the engine, ABI, history traversal or hook source policy. Alongside the proved byte-cap/empty cases above, `sanitizeToolResult` builds the same fresh result with direct optional-field assignments instead of intermediate spread objects. `sanitizeJson` allocates its cycle-tracking set only for objects, retains all prototype/cycle/depth checks and entry snapshots, and reuses the same non-global binary-field regex. Every metadata string and property name still goes through the text filter; arrays and objects are still freshly cloned, even with no matches. Key collisions, binary withholding, argument-name preservation and value-free sticky refusal remain unchanged.

Production profiling uses `/tmp/redaction-bridge-round2.3MZhyD/hot-path.mjs` and the parent-provided addon at `$HOME/Worktrees/dotfiles/feat-redaction-speed/pi/extensions/redaction/native/redaction.node`, loaded read-only with an explicit loader. Addon SHA256 remained `8d9d6be8dba672ac220c6445b138d575307118985594b2c96e72319663e40da4` throughout. The TEMP `before/` source snapshot is the unchanged first-pass bridge/sanitizer. `paired-final.json` contains three paired trials, reversed order on alternate trials, 2,000 warmups, 31 samples × 1,024 calls per layer/trial, identical synthetic fixtures and no result cache. Native text methods, production bridge/sanitizer, and actual registered `tool_result` hooks are exercised; cold initialization is excluded.

Median trial p50/p95 in **microseconds**, before → second pass:

| Representative route/fixture | Before | After |
| --- | --- | --- |
| Empty text bridge | .2512/.2840 | .0218/.0227 |
| Empty hook | .4154/.4842 | .0489/.1213 |
| One-byte hook | .4186/.4976 | .3170/.3639 |
| Four-byte hook | .4314/.5195 | .3338/.4178 |
| Structured hook: four text blocks + nested benign metadata | 8.7489/9.0246 | 8.0729/8.3428 |
| Same structured sanitizer with identity filter (diagnostic) | 1.3624/1.4395 | 1.2191/1.2703 |
| Nested actual email/phone keys/values hook | 5.4669/5.7150 | 4.9786/5.1601 |

These are component/representative production-hot-path measurements, **not a rerun of the parent benchmark or an upstream speedup claim**. The structured fixture is explicitly recorded in the TEMP probe and richer than the parent's exact structured workload. Another paired probe measured only ~3% structured improvement versus ~8% here: small differences are noisy and not acceptance evidence by themselves. Node CPU profiles in the same TEMP directory attribute much time to synchronous native text calls and `sanitizeJson`; V8 attribution includes native work in the JS caller. Sanitizer validation/cloning and per-field native calls remain material costs.

**Fairness caveat:** the upstream comparator performs less metadata/structured/property-key sanitation. The local structured-hook gap is not equivalent protection work; do not remove those scans, validations or cloning to claim a win. The parent-reported original twelve workloads being faster does not establish every tiny/structured case faster. Native Unicode extraction/reserved-token work is separately owned and untouched here.

Final focused config/native/extension/file tests: **113 passed, zero failed/skipped**. Strict TEMP TypeScript check passed. Additional read-only real-addon probes (`correctness.mjs`) compare tiny/Unicode/literal/empty outputs, check empty invalid configuration, no-match historical/max-ID reservations and malformed-ID refusals, and sanitize nested actual email/phone secrets in keys and values without mutating original data. Committed regression tests retain malformed nonempty ABI refusals and add tiny Unicode, exact three-byte cap transitions, validated-empty/legacy dispatch, clone/snapshot/collision/object/binary policies, plus history/failure guards on empty hook calls. Those isolated bridge-pass results precede the integrated second-pass assembly. Integrated validation rebuilds native and reruns complete suites; upstream benchmark acceptance remains parent-owned. The bridge writer did not create/copy a native binary or modify integration/benchmark files.

## Third bounded pass: optional native-certified marker absence

The parent-approved third-pass contract adds optional native `negativeProofAsciiV1(): string | null`, now integrated with the rebuilt addon. Actual-addon integration tests verify certificate equivalence, guarded short-field routing, marker/history dispatch and metadata clone isolation. This is not an achieved whole-hook performance claim. Earlier measured tables above remain historical/component evidence.

Only a successfully constructed/config-validated engine with both V1 methods may supply the descriptor. Absence retains normal nonempty V1 dispatch; explicit null disables the proof. Legacy ignores this new capability and retains full dispatch. Wrong-typed availability/results, throwing getters/methods, descriptors longer than 17 units or characters outside the approved ASCII set (`[`, `@`, digits, `-`, `s/g/A/x`) fail with the fixed generic error. Bounded duplicate markers are harmless and accepted. Any string descriptor on a literal-bearing engine refuses: this check uses the exact immutable JSON snapshot passed to the native constructor, never subsequently mutable caller configuration. Native owns marker sufficiency, detector grammar and default-budget certification; JS does not recreate a per-detector marker table.

Validated descriptor characters are individually encoded as literal `\xNN` character-class data and compiled once into a non-global RegExp. Empty descriptor compiles an empty class, certifying no required markers for an eligible engine. No user-provided regex syntax is accepted. This caches compiled configuration only, **not inputs/results**.

After strict input type, well-formedness and byte-budget checks and all existing caller history/failure guards, fields of at most **256 UTF16 units** without a descriptor marker return unchanged text/zero spans without a per-field native scan. Every marker-present field, and every nonempty field longer than 256 units, dispatches normally. Zero-span short fields have at most 768 UTF8 bytes and a legacy-equivalent transport bound of `24 + 6*768 = 4632` bytes, below fixed defaults. The existing validated-V1 empty shortcut remains. Proof results return new result/match containers where required; all metadata/structured/property-name sanitation, cloning, object validation, collision/binary policy and source exceptions remain untouched.

Mock ABI tests cover every allowed marker (including bracket/dash escaping), repeated non-global tests, duplicate/empty descriptors, 256/257-unit cutoff, malformed/throwing/wrong-type descriptors, partial/legacy/old/null capabilities, immutable constructor configuration versus caller mutation, literal refusal/null fallback, Unicode/types/caps, and token reservation/refusal. Actual registered-hook tests exercise benign nested data clones, sensitive metadata keys/values, historical reservation/tree reset before new allocation, invalid descriptor latch, missing history, malformed IDs/Unicode, cycles/nonplain objects/collisions, binary withholding and direct-user exemption. Final focused config/native/extension/file tests: **125 passed, zero failed/skipped**; strict TEMP typecheck passed.

A TEMP mocked-boundary/primitive probe (`/tmp/redaction-bridge-round3.th7tIm/mock-boundary.mjs`, `mock-boundary.json`) runs production bridge/hook wrappers with explicit JS zero-span ABI mocks, not an actual native certificate. Node26.10.0; three alternating-order trials, 2000 warmups, 31 samples × 4096 calls. Median trial p50 microseconds for the escaped class versus an `indexOf` marker union: four-byte ASCII `.0149` versus `.0857`; short Unicode `.0139` versus `.1237`; 256 clean units `.0227` versus `.1621`. This supports using the optimized character-class primitive. The whole mocked four-byte bridge is **slower** with the guard (`.0220`→`.0357` us) than a zero-work JS backend: that measurement exposes predicate overhead and excludes any native-call savings. The corresponding structured mock hook is `1.4719`→`1.7237` us. Neither is a native speed claim or an upstream comparison.

Native differential tests and actual-addon integration cases verify the joined descriptor absence certificate/state guarantees across detector toggles, literals, corpus and tested adversarial Unicode/IDs/budgets. Benchmark route assertions must allow certified short-field proof returns only after constructor/pair/descriptor validation, while sensitive/marker fields still exercise V1 and zero legacy fallback remains enforced. Re-run every original/tiny/structured workload and controls with the same sanitation scope. Upstream still performs less metadata/key/structured sanitation; that fairness difference cannot be removed to claim a win. Native Unicode alias-at-end parsing/extraction is separately owned and unchanged here.
