# Pinned backend source and local compatibility patches

## Origin and notices

- Package: **`@aliou/pi-processes` 0.12.0**.
- Repository: https://github.com/aliou/pi-processes
- Research-pinned source commit: **`16c1080030e5efd175a268e44ce665fb97bcb68f`**. Commit association is supplied research evidence, not a new network/Git verification.
- Exact source used: `/tmp/pi-processes-research.BwEQmU/package`.
- Tarball: `/tmp/pi-processes-research.BwEQmU/upstream-0.12.0.tgz`.
- SHA-512 independently checked locally: `sha512-Xf/lWTQ15M0ZJKjZrbmuhWHnJtSD5h9lQKVNJpwqy4njZhlqRwMLyJ55j16tOUDEujbTPPmZpBecBJPuQJ9R9Q==`.
- Both supplied package manifest and README declare **MIT**. The manifest has **no author field**. No standalone LICENSE, COPYING, or NOTICE was supplied. No copyright holder, author, year, or missing permission text is inferred or invented here. This missing standalone notice remains a provenance limitation; no contradictory license terms were found in the supplied material.
- `upstream-metadata/package.json`, `README.md`, and `CONTRIBUTING.md` preserve the exact supplied bytes, including all metadata/notices. Their publication/discovery/dependency declarations are historical evidence, **not this local package's configuration**. Local publication is not authorized.
- `upstream-metadata/source/**/*.ts.txt` preserves each selected original source verbatim, including original comments. These are non-executable audit copies, not extension entrypoints. Source comments in adapted files can be corrected without erasing supplied text.
- `source-manifest.json` maps each original path to its adapted target and original archive, supplies SHA-256 hashes for both, and describes local changes. It also records the two moved local helpers. The upstream contribution testing skill and upstream tests are not shipped in this package; no claim is made to have run them.

The transcript/skill component should reference these shared supplied notices and maintain its own source map. Do not load the upstream package concurrently with this extension.

## Actual reuse boundary

`runtime.ts` is now the compatibility facade, not the old process implementation behind a renamed wrapper:

```
Runtime facade
  → ProcessManager
    → ProcessRegistry
    → ProcessRuntimeController
    → ProcessLogStore
    → ProcessOutput
  → NotificationRegistry / NotificationService / LogMatchers
    → aggregate notification throttle
    → frozen local RuntimeEvent
```

The actual upstream registry, manager composition, line/event assembler, bounded UTF-8 log reader, finished-record reaper, notification policy/state synchronization, line matchers, and aggregate throttle are adapted and executed. The controller's unsafe lifecycle/signaling paths are substantially patched rather than retained for parity. All selected code uses Node built-ins and direct `.ts` imports. No upstream UI, settings, AST/shell parsing framework, daemon, interception, adoption API, dock, or cross-extension process-control protocol is imported. No new runtime dependency is required.

Local code moved from the previous runtime: the bounded streaming control-character sanitizer and Runtime input validation. The facade owns only compatibility projection, acknowledgments/notification configuration, detached revisioned snapshots, output response budgeting and observer invalidation coalescing. It delegates real spawning, ownership, signaling, stdin, file logs, line assembly, terminal completion and reaping to the adapted manager.

## Frozen public seam and additions

All existing Runtime methods and required Run/Snapshot fields remain. The read-only `processes:snapshot:v1` / `processes:snapshot:request:v1` protocol, version 1 payload, default status colors, and `defaultStatus:false` behavior are untouched in their original owner files.

Additions exported from `types.ts`:

```ts
// Both Run and OutputResult:
stdoutFile?: string;
stderrFile?: string;

export type NotificationDetails =
  | { version: 1; timestamp: number; kind: 'completion'; run: Run }
  | { version: 1; timestamp: number; kind: 'watch'; run: Run;
      watch: { pattern: string; mode: 'literal'; stream: 'stdout'|'stderr';
        line: string; matcherIndex: number } }
  | { version: 1; timestamp: number; kind: 'suppression'; suppressedCount: number };
```

`RuntimeEvent` notification retains `key`, `id`, `kind:'completion'|'watch'`, `attention`, `text`; it adds optional `details?: NotificationDetails`. Suppression uses outer `kind:'watch'`, `attention:'context'`, `id:'*'`, a unique session sequence key, and **no fabricated run**. Details contain sanitized, detached event-time data. Watch previews are at most 160 characters; pattern 500; run name 512, command 8192, cwd 4096, error 4000 characters. Renderer replay must use persisted details, not look up a mutable/current run. Explicit projection drops unknown notify/watch fields and private matcher identities.

Real paths identify currently retained private raw stream files. They may contain secrets and terminal control bytes, may represent different windows after rotation, and disappear on clear, reaping or disposal. They are not lifetime-complete logs. Combined output is a private sanitized chunk file; it is not exposed as an upstream tagged combined-log API.

## Deliberate compatibility and safety changes

- Opaque UUIDs replace reusable short upstream process IDs. No PID-based authority API is added.
- Upstream detached **bash `-lc`** is retained. Shell startup files can affect commands. Windows remains unsupported; no PTY, automatic restart, daemon or cross-session adoption exists.
- ChildProcess owner exit permanently revokes all group signals **and liveness probes**, regardless of stale status/PGID reuse. Already-observed ChildProcess exit/signal fields also deny signaling before listener dispatch. Liveness loss while eligible revokes authority rather than attempting PID recovery.
- A TERM timeout remains active (`stop-timeout`), without outcome or terminal timestamp. Genuine later exit finalizes once. Only explicit `stop(id,true)` requests force during normal operation; ordinary stop never escalates. Bounded session shutdown attempts TERM then KILL only against eligible owned groups.
- Stdin writes retain callback/error/close/backpressure completion, overlapping-write rejection, exact bytes/EOF, and the 50 KiB input limit.
- Owner exit starts a **200 ms** inherited-pipe drain. Final assembled tail watches flush before completion. Undrained descendants produce a retained warning before the completion event; warning visibility overrides ignored success/kill. Clear during drain closes pipes and records a warning without signaling a stale group. Reentrant final-tail clear preserves notification policy until synchronous completion finishes.
- Cleanup is awaited, bounded and idempotent. Signal, asynchronous log write, read, deletion and cleanup failures are not silently reported as success. Cleanup rejects with collected errors/warnings. No unbounded disk write queue is introduced.
- Explicit `logRoot` is only a caller-owned **parent** for a lazily allocated private temporary child. Root mode is 0700, exclusive files 0600. Only owned child storage is deleted. A vanished log is not silently recreated. Filesystem errors in stream callbacks become retained warnings, not uncaught host exceptions.
- Upstream truncate-and-restart retention is retained, patched so a giant incoming chunk plus marker cannot exceed the cap. Rotation flags are tracked independently of user-controlled marker text; UTF-8 suffixes are aligned. The combined file retains safe chunks, including live unterminated output, rather than truncating it to watch-event line heads.

## Bounds and intentional parity gaps

- Default **64 MiB separately for stdout, stderr and combined**: up to roughly **192 MiB/run**, not a session disk quota. `maxLogBytes` remains configurable (1 byte–64 MiB). Recent and live records can exceed 50.
- Upstream reaping removes only the oldest **excess finished records above 50**, once they have been finished for at least **five minutes**. Finished records within grace, the newest 50 and active/timeout records are retained. Explicit `maxRuns` still enforces a hard capacity across retained records. Unacknowledged failure counts describe retained runs, not permanent failure history.
- Runtime output defaults to 100 lines; at most 2000 returned lines, a 5000-line filter scan, upstream 2 MiB tail-read budget, and **50 KiB response text**. Rotation/read/line/response truncation is surfaced conservatively. Raw retained paths support deeper inspection, subject to their own retention window.
- Watches use complete **per-stream lines**, including chunk-split assembly. They run at newline or final EOF/drain flush, not immediately on unterminated readiness text. No cross-stream matching or completed-log replay. Watch changes flush already assembled pending events against the old configuration; an unfinished line remains an in-flight line until completed.
- Upstream bounds: 64 KiB pending line, 32 KiB emitted line, 2000 event lines (temporary trimming threshold 4000). Oversized logical tails are dropped through newline, and lines over **10,000 characters** are not matched. High-volume event buffers can drop older lines; this is not a lossless log-monitoring protocol.
- At most 20 matchers/process, 1–500-character literal patterns. One-shot is default. Repeating matches have the upstream **15-second** cooldown. Append/remove preserve stable one-shot/cooldown identities, including duplicate patterns; replace/clear reset the generation. No historical file scan occurs on watch edits.
- **Regex is explicitly rejected** at Runtime start/update/output and the internal compiler, including legacy update modes. Upstream synchronous `RegExp.test` cannot be safely time-bounded; no worker evaluator is added in this migration.
- Aggregate delivery retains upstream **20 watch notifications/minute** and a context-only numeric suppression summary. Completion notifications are not throttled. All timers/subscriptions are canceled on disposal; no second aggregate throttle belongs in index.ts.
- Default successful/failed completions still request a turn. External signals default to context. Intentional stop is context. Failure/watch `ignore` becomes context; ignored successful/external-signal events stay suppressed unless a warning requires visibility.

## Checks and limitations

Backend facade and deterministic source-named unit tests are in root `runtime.test.ts`, so the existing non-recursive test command runs them:

```
node --experimental-strip-types --import ./tests/register-loader.mjs --test ./runtime.test.ts
node --experimental-strip-types --import ./tests/register-loader.mjs --test ./*.test.ts
```

The tests use only owned harmless fixtures, existing installed peers, bounded observations/cleanup, fake clocks for 15-second/60-second/five-minute policies, and direct unit records for reaper/signaling races. No five-minute real wait or external process discovery is used. Main/live settings and all adapter/tool/UI/index/status/skill files remain outside this owner's edits.

Abrupt host death, escaped/redirected descendants, resource usage of arbitrary launched commands, raw-log secrecy, and real terminal/IME behavior remain outside these guarantees. Missing standalone upstream license notice is disclosed above. Tests do not constitute a publication authorization or an upstream legal attribution assertion.
