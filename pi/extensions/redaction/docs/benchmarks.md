# Synthetic corpus and reproducible benchmarks

## Reproduce safely

From this package, run `npm run benchmark` (or `bash benchmarks/run.sh [output.json]`). Requires Node >=22.18, Python 3, curl/tar, cargo/rustc and network access **only for pinned public source/tooling acquisition**. No secret/service validation occurs. Runtime dependencies are not installed in the repository or globally; TypeScript 5.9.3 and Node types 22.20.0, comparator source, package copies and builds use a temporary directory removed on exit. npm uses distinct empty temporary user/global configs. The comparator process gets a synthetic temporary HOME; it cannot load the live Pi policy. No Pi session/provider is launched, user configuration modified, or git command invoked.

The machine-readable measured run is [benchmarks/results/latest.json](../benchmarks/results/latest.json): environment, pinned revisions, source/config/corpus hashes, explicit configs, workload hashes/bytes/match counts, construction/first-call diagnostics, all 21 sample means, p50/p95 and throughput. It contains no home/TEMP paths, private values or downloaded comparator code. Local source handoffs are uncommitted: content hashes, not a fabricated local revision, identify them.

The small [corpus](../fixtures/README.md) has 14 synthetic cases selected/adapted from pinned Presidio, Gitleaks and scrubadub tests plus one original synthetic token. Exact provenance, modifications, upstream/local expectations and full licenses are included. `npm run build:native && npm run test:corpus` checks all-off preservation, individual opt-ins, original spans, idempotence, mixed Unicode and license hashes (17 corpus tests plus the contaminated-pack regression). The corpus exposed an actual unspaced parenthesized-phone gap; the native owner fixed it and added bounded regressions. The retained `(415)555-0132` expectation now passes; no case was weakened to pass.

## Comparison boundaries

Comparator: **pi-redact-all 0.2.5**, `steimerbyte/pi-redact-all` commit **`a1a189f970f53c81f90c8de587c59c72cefec5ee`**, compiled from pinned source in TEMP. This is not an evaluation of every upstream layer.

- Shared workloads contain reserved ASCII emails and fictional **compact E.164 `+14155550132`** phones, matching the common supported intersection. Local only enables `email` and `phone`; literals and other detectors are OFF.
- Fair comparator configuration enables only `layers.pii` and sets **`minLength: 1`**. Its single PII switch also enables IPv4, cards, SSN and IBAN scans; no per-category selectors exist. Thus inputs/required removals are equivalent, but recognizer workload and complete policies are **not** identical. Full normalized rendered outputs are asserted equal and all expected sensitive identities must be absent **before timing**. Exact native/bridge match counts are also checked; clean inputs must stay unchanged.
- Defaults run separately (PII OFF, minimum total input length 32, other layers ON). Both default paths miss the two expected identities in all 9 non-clean shared workloads; 18 measurement rows explicitly fail correctness. These timings are **not speed wins**. Separate short probes show that even PII ON with the default minimum 32 misses `a@example.com` and `+14155550132`.
- Detection differs outside the intersection: local handles `415-555-0132` and `(415)555-0132`; fair upstream preserves those US formats. Local preserves the extension in `415-555-0132 ext.12`. Both preserve `info@example.`. Probes and corpus policy notes expose these differences; there is no general recognizer parity or accuracy claim.
- Exact-literal scaling has **no direct upstream counterpart** and is not presented as an equivalent speedup. Dictionaries contain 1/100/1000 distinct synthetic keys with shared prefixes. Non-clean input repeatedly hits only the first and last key (one identity at rule count 1); this is matcher/rule-count scaling, not a many-identity stress test.

Source flags in the synthetic hook config are `toolResults=true`, `userMessages=false`, `systemPrompt=false`; direct-user exception, private config and filesystem round trips are tested elsewhere, not timed here.

## Method

Fixed deterministic generation, no PRNG/ambient inputs: clean, sparse (one secret pair per 40 clean lines), dense (secret pairs only), and Unicode sparse (emoji/CJK/accent prose around ASCII targets). Requested UTF-8 sizes 1/16/128 KiB are rounded **up** to complete chunks to avoid clipped secrets/surrogates. Twelve shared workloads plus twenty literal workloads vary three rule counts at 16 KiB and three sizes at 100 rules. Actual sizes are recorded; Unicode is not a non-ASCII-email coverage claim.

Per workload/implementation: correctness first, **5 warmups, 21 samples × 3 scans**; p50/p95 are nearest-rank quantiles of those **batch means**, not individual-call latency tails. Throughput uses actual UTF-8 input bytes divided by p50 time. Engines and identity maps persist during repeats. One sequential process run; no forced GC, process isolation per sample, statistical confidence intervals or cross-platform guarantee. Sub-millisecond cases are noisy.

Measurement layers are distinct:

1. **Rust core**: release engine, no N-API, black-box result; no JSON serialization/FFI/Node work. Config construction reported separately.
2. **N-API JSON**: native scan + JSON serialization + string transfer, excludes parsing/UTF-16 validation. Correctness parses once outside timing.
3. **TS bridge**: additionally JSON parse, UTF-8→UTF-16 conversion, span/output validation.
4. **Registered tool_result callback**: actual extension callback with one text block and no details/structuredContent. Local includes bridge, safe wrapper and historical-alias guard with a stable benign `sessionManager.getBranch()=>[]`; no retained-history traversal scaling is measured. Upstream includes its real stats **second scan** for changed text. Empty mocked host registration avoids Pi runtime dependencies. This is **not** a live Pi/full-request pipeline, filesystem, history/context, provider or transport benchmark. JS measurements include awaited dispatch per invocation.
5. **Upstream layers**: direct registry call, no stats/hook overhead.

Build/download/npm/import/constructor/first-call diagnostics are separate, never folded into hot throughput. First calls are not repeated fresh-process cold-start distributions. `cold.coreProcessWithAllScansMs` is explicitly the whole core child-process run, not a scan/setup latency.

## Final corrected-source run (2026-10-10T13:37:31.299Z)

Darwin arm64 25.3.0, Apple M1 Pro (10 logical CPUs), Node 26.10.0, rustc/cargo 1.98.1. **One completed run**, no repeated-run selection or detector tuning. All **152 non-default measurement rows** passed pre-timing correctness; 18 of 24 defaults rows missed expected removals (the 6 clean rows passed). Final source identities:

- Native: `47ddad9f4a1684d9c15f6c963708c7c0f577b92e9da475e1d7e9063f42261833`
- Hook: `7e90c2b3372cedc27e79a95148a7f6c50ebde01622af2300870863fe97b2c785`
- Runner (including stable benign session-manager context): `291394f46c2f4a8ef130447a7a2139f5a3ab990dafce70859e42e0514c1dcbab`

This table replaces the earlier pre-review figures using native `6299f93ab1f1…`. It reflects the assembled native alias-boundary fixes and adapter history-reservation integration; file bounds are tested separately, not timed here. No old/new timing ratio or causal performance conclusion is claimed. Fresh post-run package validation: **28 Rust + 11 addon + 119 TS = 158 passing tests**, including 17 corpus and 1 packaging regression. The integrator also independently rebuilt/tested all 158 from packed source. Contaminated packing preserves 51 source files and excludes all 19 dummy artifacts; benchmark publication allows exactly seven intended files.

### Shared inputs, requested 128 KiB

Times in milliseconds, **p50 / p95**, rounded to three decimal places; actual bytes: clean 131088, sparse/dense 131076, Unicode 132219. Exact unrounded numbers and all samples are in JSON.

| Path | Clean | Sparse | Dense | Unicode sparse |
| --- | ---: | ---: | ---: | ---: |
| Rust core | 0.241 / 0.247 | 0.274 / 0.293 | 1.451 / 1.484 | 0.270 / 0.287 |
| N-API JSON | 0.434 / 0.468 | 0.515 / 0.549 | 2.864 / 2.920 | 0.979 / 1.139 |
| TS bridge | 0.952 / 1.026 | 1.115 / 1.186 | 5.281 / 5.375 | 1.630 / 1.832 |
| Local registered hook | 0.966 / 1.029 | 1.126 / 1.189 | 4.996 / 5.203 | 1.555 / 1.731 |
| Upstream PII min1 layers | 0.197 / 0.207 | 1.220 / 1.284 | 47.302 / 63.810 | 1.026 / 1.137 |
| Upstream PII min1 hook | 0.192 / 0.198 | 2.467 / 2.573 | 95.297 / 97.813 | 2.053 / 2.203 |

Local-hook throughput (MiB/s): **129.4 clean, 111.1 sparse, 25.0 dense, 81.1 Unicode**. Upstream fair-hook throughput: **650.6, 50.7, 1.3, 61.4**, respectively. Upstream layers outperform the TS bridge on clean and Unicode input; dense results favor local markedly, with upstream's overlap scanning and hook rescan contributing. Independently warmed blocks can invert expected hook/bridge/layer ordering because of JIT/GC/scheduling noise; an inversion is not proof that a wrapper is cheaper. There is **no universal speedup claim** and core-only numbers are not compared as full-extension numbers.

### Defaults diagnostic only, requested 128 KiB

PII is OFF under upstream defaults. Clean rows pass; **every sparse, dense and Unicode row below misses both expected identities**. These are not equivalent-work timings or speed wins.

| Path | Clean (passes) | Sparse (misses) | Dense (misses) | Unicode (misses) |
| --- | ---: | ---: | ---: | ---: |
| Upstream defaults layers | 3.369 / 3.471 | 3.484 / 3.619 | 3.096 / 3.227 | 2.693 / 2.748 |
| Upstream defaults hook | 3.320 / 3.401 | 3.514 / 3.561 | 3.030 / 3.143 | 2.709 / 2.749 |

### Exact-literal scaling only, requested 16 KiB dense

| Rules | Core p50 / p95 ms | Local-hook p50 / p95 ms | Hook MiB/s |
| ---: | ---: | ---: | ---: |
| 1 | 0.035 / 0.035 | 0.333 / 0.340 | 47.1 |
| 100 | 0.066 / 0.070 | 0.365 / 0.381 | 42.9 |
| 1000 | 0.079 / 0.083 | 0.377 / 0.403 | 41.5 |

Core construction for these rows: 0.093 / 0.567 / 2.121 ms. N-API construction: 0.167 / 0.641 / 2.390 ms. Clean-core sub-microsecond/single-microsecond scans should not be used for strong scaling conclusions. Every full size/pattern/rule-count result is retained in JSON.

### One-off setup diagnostics

Source download 1.155 s; temporary npm tooling 1.918 s; comparator compilation 0.932 s; addon build 9.985 s; Rust harness build 6.578 s. Fresh temporary target/npm cache, but machine Cargo registry cache may already be warm. Comparator module imports 6.239 ms; native dlopen 307.323 ms. Local TypeScript static imports precede timing. These are single observations and include machine/load/signing/cache effects, not stable startup guarantees. Measured workload execution plus setup completes in minutes.

## Limits

Synthetic selected cases do not estimate precision/recall on real-world data. Enabled detectors are heuristic; no network validation, compliance guarantee or universal egress mediation. Benchmarks intentionally exclude private inputs, live Pi configuration, filesystem races and other extension/provider paths. Independent reviewer gate and parent integration acceptance remain required; do not enable or publish the package from this evidence alone.
