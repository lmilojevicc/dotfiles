# Synthetic corpus and governed benchmarks

## Reproduce safely

Run `bash benchmarks/run.sh [output.json]` from this package (or `npm run benchmark` with npm tooling only in an isolated TEMP package). This benchmark requires **normal-shell Node26.10.0**, Python3, curl/tar and cargo/rustc. Public source/tooling acquisition uses network; no service/secret validation, live Pi/provider, private config/history or user file workload is used. TypeScript5.9.3/Node types22.20.0, pinned comparator source, package copies and builds stay TEMP and are removed on exit. npm uses empty isolated configs/cache; measured comparator gets synthetic HOME. No git/gh, activation/settings edits, repository/global dependency installs or npm publishing.

[Machine evidence](../benchmarks/results/latest.json) contains the final environment/source/config/archive/corpus/payload hashes, all distributions, quantiles, per-trial batch/warmup counts, route counters, cold diagnostics and every comparison. No home/private/TEMP absolute paths. Local uncommitted sources are identified by authoritative content hashes, not an invented revision. Default output updates local evidence only, not acceptance/publication to a package registry.

The [corpus](../fixtures/README.md) contains **15 selected synthetic cases**, adapted/original with pinned Presidio/Gitleaks/scrubadub provenance and full licenses; not entire upstream-suite or precision/recall parity. `node scripts/build-native.mjs` then `node --test tests/corpus*.test.ts` checks every original detector opt-in/span/idempotence/cap/license assertion and contaminated TEMP packaging. No existing fixture expectation was weakened. Package packing still allows exactly seven intended benchmark files and excludes binaries/targets/private artifacts.

## Declared comparison and unchanged workload boundary

Comparator **pi-redact-all0.2.5**, commit **`a1a189f970f53c81f90c8de587c59c72cefec5ee`**. Fair configuration: only `layers.pii`, **minLength1**, original masks/config unchanged. Local only enables email/phone, other detectors/literals OFF on shared rows. Upstream PII also scans IPv4/cards/SSN/IBAN; required shared removals agree but entire policies and recognizer workloads are **not identical**.

Original **32 workloads retained byte-for-byte**, including all twelve shared clean/sparse/dense/Unicode1/16/128KiB cases and twenty local literal cases. All fifty first-candidate and fifty-four second-candidate text/config/event hashes were explicitly checked unchanged. No case removed/relabelled to erase a loss. Added controls do not replace originals.

Current54 cases:

- **32 comparable shared PII rows**: original12; nonempty short fields; Unicode CLEAN; isolated near-match `@`/digit/delimiter characters without valid sensitive matches; already-redacted tokens;32 cycling changing identities; four text blocks plus benign nested metadata; and all four long-prefix/late-marker controls.
- **One explicit empty diagnostic**, retained with its ratio/distribution: upstream bypasses minLength1; approved local bridge bypasses only after constructor/config/paired/certificate validation. Different completed-scan work, never counted as a speed victory.
- **Twenty literal cases**,1/100/1000 rules and1/16/128KiB sizes: local-only, no upstream literal counterpart or equivalent speed claim. Repeated first/last key hits measure rule scaling, not many-identity stress.
- **One sensitive nested structured-result case**, local-only: upstream does not sanitize sensitive metadata/property keys/structuredContent. No equivalent speed claim. The comparable four-text row keeps benign metadata identical and still pays all local scanning/clone safeguards; it was not relabelled away when slower.

Original generated chunks are complete UTF8/surrogate-safe repetitions reaching requested minimum bytes. Actual bytes recorded. Unicode prose is emoji/CJK/accent around reserved ASCII detector examples, not non-ASCII-email accuracy evidence. Near-match digits are isolated by non-phone delimiters and assertions require exact preservation. Changing32 fictional identities cycle without result caching; native session aliases remain stable. Source flags: toolResults=true,userMessages=false,systemPrompt=false. Direct-user/privacy/file safety is tested separately, not weakened for timing.

Defaults are **not equivalent** (PII OFF, minimum32); retained historical defaults misses/probes are never speed wins. Short probes still expose default-min32 misses, differing US phone formats and incomplete email negatives. No general recognizer parity claim.

## Method and measured layers

**Three fresh-process independent trials**, new engines/hook state per trial, paired implementations interleaved with rotating/reversed order over21 samples. Warmup >=20 calls and>=50ms; adaptive1..8192 calls/batch targets>=5ms. Tiny calls may reach cap before5ms; hundreds of thousands of calls and complete distributions are retained. Engines/identity maps persist within a trial. No full-input/result cache or special-case benchmark strings.

p50/p95 are nearest-rank quantiles of all **63 batch means**, not individual-call tail latency. Each trial's samples/batch/warmup/p50/p95/min/max retained. Throughput counts scanned UTF8 text leaves (mean bytes for changing sequences), not serialized protocol size; nested local hook counts all repeated sensitive occurrences. One host/runtime, no forced GC/confidence interval/cross-platform guarantee; JIT/GC/scheduling noise remains.

Correctness precedes timing: exact native/local rendered output and match counts; exact unchanged output; normalized full upstream output; stateful token-history reservation, next-ID allocation, stable aliases/idempotence and user exemption. No censorship counted as successful scanning. Instrumentation outside timing proves one **actual native** certificate negotiation per local hook, literal=null, exact forwarding of every long/marker/sensitive field, and zero legacy/span calls in ordinary hook text. <=256-unit no-marker fields may use validated native-certified proof, not a forced FFI call; all metadata/key/clone checks remain. Sensitive/marker fields call V1. No JavaScript detector grammar substitutes for native certification.

Layers kept separate:

1. **Rust core**: release owned engine, no NAPI/JSON/Node; black-box results; construction separate.
2. **Native V1 text**: scan/native proof plus FFI/string representation; no JS bridge.
3. **TS structured bridge**: original UTF16 span validation/reconstruction; native certificate can discharge short zero-span inputs.
4. **TS text bridge**: strict Unicode/type/budget and approved native proof/render trust; no file spans.
5. **Registered tool-result hook**: actual production loader/callback, safe wrapper/history guard, all content/metadata/structured sanitation. Synthetic registration/schema factories and stable benign getBranch; not live Pi/provider/file/history-scaling/full-request transport.
6. **Upstream layers/hook**: real pinned callbacks; changed hook content incurs upstream stats second scan.
7. **Legacy native JSON diagnostic**: scan/serialization/transfer, timed parsing excluded; compatible old path, not mistaken for optimized hook.

Download/tooling/build/module import/constructor/hook registration/first correctness sequence are separate diagnostics, not hot throughput. First sequence includes checks/instrumentation, not fresh first-call latency. Whole core child-process duration includes all scans and is not setup/scan latency.

## Final corrected-source run

Generated **2026-10-10T16:16:10.488Z**, Darwin arm6425.3.0, Apple M1 Pro10 logical CPUs, Node26.10.0, Rust/cargo1.98.1. **390 aggregate rows /1170 trial rows** all pass correctness. Three complete trials retained, no favorable-trial selection.

**Measured matrix target met:** local registered hook has lower pooled **p50 and p95 on all32 comparable rows**, and lower p50 in **all three trials for each row**. Worse-case count **0/32**, both p50 and p95. This is a scoped one-machine result for this declared matrix, **not a universal speed guarantee** or overall release acceptance. Empty diagnostic remains separate/mixed; literals and sensitive structured data remain local-only.

Authoritative sources:

- nativeSource: `9483f5cccee31df6a550927714102db27424557b9670708986fd750084cc69ac`.
- bridge: `18d36e8bfab88bd90b93470660e46df8b52d553c3b00bab340aefdaa8396f026`.
- hook: `31074deac8f57be6567c40da5350beabe2074d214789c063bbed85d7757ff71a`.
- sanitizer: `1418dc03a5236b7126ce2360be4f3a3e0012dd5b5e84daca1e8226820b0d0796`.
- runner: `07f550b9c565d20fc99ab9a3cf56c82a1312dafc52ffc570154945e2337b2653`.
- workloads: `76db238a202a9f78f4ffc331e28eb4526fe37f2d0c2ab95b63c4e37d7549ff99`.

### Every shared hook comparison

Times **p50/p95 microseconds**; ratio local/upstream pooled p50, lower better. All33 shared inputs shown, including non-equivalent empty:

| Case | Local µs | Upstream µs | Ratio | Three trial ratios |
| --- | ---: | ---: | ---: | --- |
| pii-clean-1024-rules0 | 0.724/0.806 | 1.953/2.083 | 0.371 | 0.372/0.389/0.361 |
| pii-sparse-1024-rules0 | 5.437/5.809 | 25.116/27.285 | 0.216 | 0.217/0.215/0.217 |
| pii-dense-1024-rules0 | 12.480/13.476 | 46.235/50.047 | 0.270 | 0.271/0.270/0.271 |
| pii-unicode-1024-rules0 | 12.588/13.313 | 20.740/21.517 | 0.607 | 0.607/0.607/0.604 |
| pii-clean-16384-rules0 | 6.033/6.404 | 22.832/24.425 | 0.264 | 0.268/0.267/0.260 |
| pii-sparse-16384-rules0 | 42.115/45.307 | 226.494/246.191 | 0.186 | 0.182/0.187/0.187 |
| pii-dense-16384-rules0 | 186.547/195.254 | 1622.562/1682.740 | 0.115 | 0.116/0.116/0.115 |
| pii-unicode-16384-rules0 | 115.501/126.944 | 214.857/229.675 | 0.538 | 0.532/0.536/0.537 |
| pii-clean-131072-rules0 | 46.502/50.736 | 188.316/199.296 | 0.247 | 0.249/0.248/0.247 |
| pii-sparse-131072-rules0 | 323.898/349.156 | 2422.104/2640.521 | 0.134 | 0.134/0.133/0.134 |
| pii-dense-131072-rules0 | 1571.229/1661.635 | 93961.750/101609.042 | 0.017 | 0.017/0.017/0.017 |
| pii-unicode-131072-rules0 | 881.990/969.870 | 2037.333/2245.729 | 0.433 | 0.428/0.430/0.434 |
| pii-short-0 **diagnostic only** | 0.121/0.140 | 0.126/0.148 | 0.963 | 0.928/1.017/0.908 |
| pii-short-1 | 0.129/0.153 | 0.346/0.369 | 0.374 | 0.381/0.383/0.356 |
| pii-short-4 | 0.131/0.155 | 0.349/0.379 | 0.377 | 0.365/0.405/0.360 |
| pii-short-13 | 0.726/0.775 | 1.351/1.414 | 0.538 | 0.547/0.560/0.526 |
| pii-short-12 | 0.710/0.759 | 1.472/1.563 | 0.482 | 0.487/0.497/0.465 |
| pii-short-26 | 0.921/0.993 | 2.070/2.180 | 0.445 | 0.469/0.450/0.426 |
| pii-unicode-clean-1024 | 1.541/1.660 | 2.742/2.956 | 0.562 | 0.559/0.559/0.558 |
| pii-near-match-1024 | 4.385/4.944 | 9.094/9.551 | 0.482 | 0.477/0.490/0.483 |
| pii-already-redacted-1024 | 3.991/4.090 | 4.764/5.009 | 0.838 | 0.837/0.844/0.828 |
| pii-unicode-clean-16384 | 19.291/19.947 | 31.904/33.119 | 0.605 | 0.604/0.602/0.605 |
| pii-near-match-16384 | 63.436/66.088 | 202.608/209.839 | 0.313 | 0.313/0.311/0.314 |
| pii-already-redacted-16384 | 50.238/52.815 | 91.528/99.030 | 0.549 | 0.547/0.549/0.543 |
| pii-unicode-clean-131072 | 154.658/161.540 | 265.448/272.599 | 0.583 | 0.583/0.583/0.586 |
| pii-near-match-131072 | 502.164/519.982 | 1644.573/1721.115 | 0.305 | 0.304/0.308/0.300 |
| pii-already-redacted-131072 | 394.891/413.901 | 759.010/813.625 | 0.520 | 0.510/0.519/0.533 |
| pii-changing-identities | 1.453/1.506 | 3.247/3.371 | 0.447 | 0.446/0.464/0.439 |
| pii-multi-text-tool-result | 2.433/2.570 | 3.520/3.751 | 0.691 | 0.695/0.696/0.674 |
| pii-unicode-clean-after-long-ascii | 300.599/309.768 | 318.159/334.000 | 0.945 | 0.949/0.941/0.932 |
| pii-unicode-email-only-at-end | 726.672/764.240 | 1307.156/1376.177 | 0.556 | 0.552/0.557/0.557 |
| pii-unicode-marker-only-at-end | 508.698/524.122 | 648.438/668.292 | 0.784 | 0.784/0.786/0.786 |
| pii-unicode-reserved-token-only-at-end | 154.294/161.565 | 266.508/276.401 | 0.579 | 0.598/0.577/0.579 |

Closest comparable row is late Unicode after long ASCII prefix: ratio.945 (trial.949/.941/.932). Empty floor~.121µs versus upstream~.126µs has mixed trial ratios(.928/1.017/.908), so **not a victory**. Nonempty short1/4 observed hook floors~.129/.131µs (exact values/distributions in JSON); these include benchmark dispatch/await and are not runtime lower bounds.

### Layer separation — original requested128KiB

Microseconds p50/p95, actual complete-chunk sizes in JSON:

| Path | Clean | Sparse | Dense | Unicode sparse |
| --- | ---: | ---: | ---: | ---: |
| local-rust-core | 20.979/21.912 | 285.100/296.845 | 1501.052/1546.688 | 268.889/284.116 |
| local-napi-text-v1 | 46.080/50.062 | 323.956/368.219 | 1568.334/1660.698 | 852.141/917.021 |
| local-ts-structured-bridge | 46.372/49.426 | 561.940/664.708 | 7901.458/8684.792 | 1165.964/1306.521 |
| local-ts-text-bridge | 46.146/49.674 | 321.539/352.021 | 1556.312/1668.760 | 879.250/986.708 |
| local-tool-result-hook | 46.502/50.736 | 323.898/349.156 | 1571.229/1661.635 | 881.990/969.870 |
| upstream-pii-min1-layers | 187.482/202.504 | 1194.573/1301.505 | 47534.084/51217.000 | 1025.260/1168.526 |
| upstream-pii-min1-tool-result-hook | 188.316/199.296 | 2422.104/2640.521 | 93961.750/101609.042 | 2037.333/2245.729 |
| local-napi-json-diagnostic | 225.471/246.078 | 527.034/591.068 | 2803.375/3111.604 | 1059.698/1186.198 |

Late-candidate controls are not hidden: exact native-owner final-position email takes full fallback/proof overhead; local native-text can be slower than raw upstream layers even when the registered local hook wins against upstream hook's rescan. Clean Unicode appearing only after63-unit sample falls back safely and is the narrowest whole-hook win. Final `@` no-match and final reserved token both remain comparable/unchanged-state controls. No claim all component paths improved.

### Literal scaling — local-only16KiB dense

| Rules | Core p50/p95 µs | Hook p50/p95 µs | Core construction ms |
| ---: | ---: | ---: | ---: |
| 1 | 36.251/37.307 | 43.644/47.105 | 0.183/0.185/0.170 |
| 100 | 63.840/71.496 | 72.574/77.422 | 0.610/0.546/0.578 |
| 1000 | 77.504/79.581 | 86.372/90.682 | 2.247/2.173/2.147 |

All twenty literal distributions remain in JSON. No upstream equivalence or universal rule-scaling claim; cold construction can vary independently of hot scanning.

## Baseline and failed attempts preserved

Historical original baseline is embedded **verbatim** as `historicalBaseline`, identifying native47ddad9f...,bridge0a956c47...,hook7e90c2b3... and its original sampling/default diagnostics. Original baseline file SHA256 **`802e197fa797483d62cfd415f99624fab719a8641fb130df0381cde711a96003`**. Different historical method: no old-baseline timing ratio/causal speedup claim.

Both failed measured candidates are preserved by source/config/payload identities, all comparisons and immutable artifact references in `priorMeasurementEvidence`; their complete distributions remain in named checkpoints. They were actual failed gates, not silently replaced with success:

- First candidate: native19b27bc0...,bridgeae7a62f3...,hook31074dea..., nine comparable losses plus empty diagnostic (initial summary counted10/29). SHA256 **`820744919e580400118f45959509deabdde920884a807a337cbd8b9f1da06b52`**, checkpoint `redaction-benchmark-checkpoint.oya0lx`.
- Second candidate: native9ee26148...,bridge4ede4262...,sanitizer1418dc03..., four pooled losses/32 comparable (three consistent, one mixed). SHA256 **`f16433e51e638d0791ccd96163ad0f6b1fec3a44b1884c05315c272f323b5f86`**, checkpoint `redaction-benchmark-second-checkpoint.tPUupI`.
- Final raw measurement: SHA256 **`fc6e59e4be44d2b5e5fd09ddaad2e2a34a6a9460a26d0c38f6400b68f480227f`**, checkpoint `redaction-benchmark-third-checkpoint.4xu8T9`. Published JSON adds derived p95 ratios/summary and archival provenance, not new timings.

Checkpoints are local TEMP evidence referenced by basename (not distributed comparator code/private paths). No intermediate trial discarded, no case/config changed. Original12 and all extended controls retained throughout; native component unfavorable control measurements remain in owner handoffs, not overwritten into upstream claims.

## Cold and validation boundary

One-off acquisition/tooling/build seconds: sourceAcquisitionMs=1.242, sourceExtractionMs=0.027, temporaryToolingInstallMs=1.971, comparatorCompileMs=0.937, localAddonBuildMs=12.205, rustBenchmarkBuildMs=8.078. Native dlopen/import distributions and per-row construction/verification are in JSON; signing/load/cache effects are substantial. Cargo registry cache may already be warm. No stable startup guarantee.

Final focused proof/integration/corpus/pack validation **49 passed,0 failed/skipped** before timing. Fresh post-run full validation passed43 Rust+195 addon/TS=238 tests, none failed/skipped; those functional gates do not themselves establish speed. After evidence/doc refresh, all22 performance-workload/corpus/pack tests passed; contaminated TEMP pack preserved59 source files, all licenses and seven intended benchmark files while excluding19 dummy artifacts. Independent review remains required before acceptance. All guard/resource/opt-in/file/source/clone guarantees preserved; no weakening to meet matrix target.

This synthetic selected matrix does not establish detector precision/recall, compliance, universal egress or RSS protection. Runtime assumptions and existing filesystem/alpha exclusions remain documented elsewhere. Parent owns independent reviewer gate, functional/performance acceptance and commits; do not activate or publish the package from this benchmark alone.
