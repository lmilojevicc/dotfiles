# Redaction extension — initial contract

Status: implementation contract; not a claim of complete protection.

## Product

Public, self-contained package under `pi/extensions/redaction/`. Private configuration lives at `~/.config/pi-redaction/config.json` (honor XDG_CONFIG_HOME); never create populated private configuration, copy user data, or log dictionary values. All sources and detectors default OFF. An absent config is inactive. An explicitly present invalid config fails closed for affected model transmission instead of silently enabling a default ruleset. No automatic global installation or activation changes.

User can independently enable exact literal mappings and automatic email, phone, API-token, private-key and credential-URL detectors. Other categories are optional later, not enabled implicitly. Source flags: `toolResults`, `userMessages`, `systemPrompt`, all false. UserMessages refers to direct text; binary/image OCR is unsupported, documented explicitly. When userMessages=false, deliberately typed raw values remain visible to the model even when tools mask the same values. Do not blanket-redact the entire serialized request in a way that removes this deliberate exception.

User-input filtering never changes on-disk project files. Auto-detection is heuristic, not a compliance/anonymization guarantee. Redaction is not an OS sandbox and does not stop direct subprocess networking, untrusted extensions, browser screenshots, raw temp logs or other model runtimes without this extension. Only trusted extension/model pipelines are in scope.

## Component boundary

### Native Rust engine (backend writer)

Own `native/**`, `scripts/build-native.mjs`, native-engine tests under native only. Rust crate with `rlib` and optional N-API `cdylib`; use `aho-corasick` for exact dictionary search and audited regex/scanners for selected detector categories. Do not introduce a large PII framework merely for recognizers. N-API is the initial integration: no process spawned for each scan. Keep compiled matcher state per engine instance. Optional dependency reuse must be license-compatible and pinned through Cargo.lock. Build script writes `native/redaction.node` locally; no binary checked in. It may use installed cargo; no global installs.

Export Node class `NativeRedactor`, constructor `(configJson: string)`, method `redact(text: string): string` returning JSON of the shape below, and `reset(): void` to clear auto aliases. Do not throw raw config, regex contents, input, matches or dictionary values in errors. Native config:

```
{
  "literals": {"me@example.com": "PRIVATE_EMAIL"},
  "detectors": {"email": false, "phone": false, "apiToken": false, "privateKey": false, "credentialUrl": false}
}
```

No literals means no exact replacements. Empty keys/values, duplicate replacement aliases (ambiguity), invalid configs and replacement cycles/collisions are rejected safely. Initial exact matching is case-sensitive, literal substring matching, leftmost-longest among literals. Literal matches take precedence over overlapping automatic matches. Render from ORIGINAL input in one pass: replacement text is never rescanned. Every output span's offsets refer to the original input. Rust uses UTF-8 byte offsets; bridge converts to JS UTF-16 indices. Result:

```
{
  "text": "some-text-PRIVATE_EMAIL.json",
  "matches": [{"start": 10, "end": 24, "replacement": "PRIVATE_EMAIL", "kind": "literal"}]
}
```

`start/end` above are illustrative; exact values are computed. Automatic matches use session-stable, collision-checked aliases (e.g. `[EMAIL_1]`), preserving different identities and avoiding original-value leakage. Document reserved alias handling. Any ambiguity between literal source text and generated aliases must be refused rather than silently restored incorrectly. No raw-value logging, no network-based secret validation. Honor all individual opt-ins; no minimum-total-input-length shortcut. Test embedded filenames, short strings, UTF-8, overlaps, no cascades, repeated values, category toggles, collision rejection and malformed config. Criterion or built-in benchmark support useful but benchmarks owned later.

### Shared TypeScript contract (parent-owned baseline)

`src/contracts.ts` below is the component seam. Native bridge returns spans indexed in UTF-16 and exposes no automatic reverse-map operation. File adapter may read originals locally and derive scoped span mappings. All error surfaces must be sanitized.

### Safe filesystem adapter (file-tools writer)

Own `src/file-tools.ts`, `tests/file-tools.test.ts`; may add helpers under `src/file-tools/` and tests prefixed `file-tools`. No Pi dependency: expose `createFileSession({cwd, redactor, protectedPaths?})` returning `{read, edit, write, reset}`. Read input `{path, offset?, limit?}` returns `{text, path}` sanitized; edit `{path, oldText, newText}` returns `{text, path}`; write `{path, content}` same. Exact-line read semantics may be simple but documented. Redact before truncation; returned partial views must not permit editing invisible ranges. Canonicalize paths, pin identity/hash, guard symlink and out-of-workspace writes. Config path protected from direct operations. Namespace native aliases to observed files/regions; engine is not a general unredactor.

Reads retain private raw/sanitized snapshots locally plus original-to-rendered span mappings. Resolve masked filenames only from known canonical paths (also support a private path alias registration method if needed; propose via supervisor). An embedded literal masked path requested before first read may resolve only through trusted configured-literal path mapping with strict collision/canonical workspace checks; otherwise fail actionable and private. No global alias substitution into shell, MCP or network.

Edits match uniquely against the sanitized snapshot, map a valid range back to the raw file, and preserve aliases only when their originals came from that edited range. Reject unknown/ambiguous/injected aliases, stale file content, partial-token matches, path escapes, and overwrite of a protected file without an observed snapshot. Whole-file write of previously observed file similarly round-trips only its own known tokens, checking unchanged-file hash. For new files disallow opaque aliases. Do not modify files merely on read. Perform queued read-check-modify-write per canonical path; avoid partial writes. Be honest that external-process races require OS support beyond an in-process queue; do not overclaim atomic compare-and-swap. Test race/stale detection, symlinks, collisions and preserving literals. A read result must not contain raw values in errors or metadata.

### Pi extension and integration adapter (Pi writer)

Own `index.ts`, `src/index.ts`, `src/config.ts`, `src/native.ts`, `src/sanitize.ts`, other src except file-tools and contracts, `tests/extension*.test.ts`, `tests/config*.test.ts`, `tests/native*.test.ts`, root package.json/tsconfig/.gitignore, `config.example.json`, README.md (short user-facing only), docs except design.md. Public package working name `pi-local-redaction` (do not publish; naming can change). MIT for new code; third-party obligations handled separately.

Load native binary lazily only when enabled. Validate config strictly; safe status shows booleans/counts only. Owner permissions warn/refuse insecure private config as appropriate, never dump config. No project override weakening global rules. Sources independently off. Avoid replacing tools or loading native engine when inactive.

Read installed Pi docs/extensions.md completely, relevant API declarations and cross-referenced docs before implementation. Verify exact `tool_result`, `context`/`context_with_system`, `input`, `before_provider_request` and tool override contracts. Hooks can fail open if they throw: explicitly return safe censored results and block/censor request construction on sanitizer failure; document coverage rather than claiming universal transport enforcement. Preserve usage/error metadata and scrub content/details/structuredContent as appropriate. Handle historical context, system opt-in and deliberate user exception. Do not mutate provider IDs, tool names or opaque signed/binary protocol fields.

Integrate safe filesystem adapter with built-in read/edit/write overrides only when toolResults enabled; preserve useful descriptions, cancellation and model-facing schema. Prefer same tools and Pi return conventions. No special model tool to reveal secrets or modify policy; manual user text is the initial reveal path. Never reverse-map arbitrary tool arguments. Clearly identify which nested tools, custom file tools, subagents and partial streaming updates are covered. Exclude images or fail privately for protected binary data, no fake OCR claims. Config file read/write protection is defense-in-depth, not same-user shell isolation.

Native bridge uses `createRequire` with exact package-relative native path; JSON methods above. Retain type-only import contracts so component tests can inject mock redactor. Node runtime supports TypeScript type stripping; tests may run `node --experimental-strip-types --test tests/*.test.ts` or equivalent temp-env TypeScript runner. npm dependencies/dev tooling only in a temporary environment; do not install globally or mutate root dotfiles deps.

## Research and benchmark ownership

Research lane identifies pinned primary source snapshots and compatible licenses for synthetic fixtures from widely used Presidio, Gitleaks and scrubadub (and selected Rust detector if reused). Never copy live secrets, run network validation, or claim entire upstream test suites are compatible with our semantics. Record original fixture/source path and revisions, retain required licenses, separate original synthetic fixtures from adapted upstream cases.

After exclusive component handoffs, integration-only writer copies claimed files into integration worktree, joins contracts, runs all tests and builds. No git operations; parent owns staging/commit. Conflicting design/API changes go to supervisor. After integration, benchmark/test-corpus writer owns benchmarks/**, fixtures/**, THIRD_PARTY_NOTICES.md and benchmark docs, runs pinned pi-redact-all in a TEMP environment, never installs/loads it in the live Pi session. Compare matched literal-only scope separately (pi-redact-all lacks same feature) and equivalent email/phone or supported PII workloads with explicit config. Correct pi-redact-all minLength32 shortcut by benchmark configuration and report defaults separately; don't turn missed detections into speed wins. No fabricated speedups. Report cold setup separately from hot scans; raw core versus N-API/Pi-hook cost separately; multiple sizes/rule counts, clean/sparse/dense, Unicode, p50/p95, throughput, deterministic seeds, correctness checks before timing. Preserve environment/revision/config/result evidence.

## Verification / release boundary

All writers confined to their named package paths in isolated worktrees. No git/gh commands by children; no publish/push/global config activation. No reading user's real private config, credentials or histories. Focused tests and independent fresh-context review required. Parent integrates only this package; unrelated main worktree edits/staging remain untouched. Source plus reproducible tests/benchmark scripts are the artifact; no native binaries, target/, node_modules, real config, raw secret logs or private fixtures committed.

## Supervisor decision: batch edits

Preserve installed Pi `edit` schema `{path, edits:[{oldText,newText}]}`. Shared FileSession now includes `editMany`. Match every disjoint edit against one original sanitized snapshot; reject overlap, ambiguity, stale content or invalid restoration before any write. Commit the complete change once under the same path queue. Never implement batch edits by looping single-edit calls. Single edit remains a convenience API.

## Supervisor decisions: redaction overlap and auxiliary calls

An automatic candidate partly intersecting a protected replacement token or a smaller literal match must not simply be dropped, leaving the rest exposed. Fully cover the sensitive region under explicit precedence or fail with a value-free error. Exact literal precedence applies only when it does not leave part of an enabled automatic candidate unprotected.

Installed Pi 1.0.4 compaction/branch summary paths bypass ordinary context/onPayload hooks. Initial adapter cancels compaction and tree navigation requesting summaries while protection is active or config invalid; unsummarized tree navigation remains allowed. Bug-report summarization has no verified supported interception hook and is explicitly unsupported: do not use it or transcript sharing as a privacy-safe operation. No private-core monkeypatch or silently reduced protection. This is an alpha with scoped guarantees, not universal egress mediation.
