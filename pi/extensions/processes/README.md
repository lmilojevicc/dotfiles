# Processes

Session-owned shell commands with the `process` tool, readable transcript blocks, and `/processes` overlay. The backend, notifications, renderers and skill substantially reuse pinned `@aliou/pi-processes` 0.12.0, adapted to this host and our ownership rules.

## Use

Start through the **process tool**, not shell background tricks:

```json
{"action":"start","name":"tests","command":"npm test","notify":{"onSuccess":"context"}}
```

Use returned opaque IDs, never PIDs or names. `cwd` defaults to the agent's working directory. Commands run in detached **bash -lc** with pipes, not a PTY; shell startup files can affect execution. Keep commands in the foreground: no `&`, daemonization or detached descendants.

- `list`: retained runs with phase/outcome, compatibility status and real retained log paths. Legacy filters/sorts remain; default limit 100, maximum 10000. `failed` includes stop timeouts and failed outcomes even after acknowledgment; `killed` means signal-ended terminal runs.
- `output`: retained tail, default 100 lines, maximum 2000 / 50 KiB of text. Literal filtering scans at most 5000 lines within a 2 MiB tail-read budget. `stream` selects stdout/stderr/both. Rotation and truncation are marked.
- `write`: exact `input`, maximum 50 KiB, no automatic newline; `end:true` explicitly closes stdin.
- `update`: rename or append/replace/remove/clear watches on a nonterminal run. At most 20 watches, 1–500 characters per pattern. **Regex is unsupported and rejected**, including legacy start/update/output requests.
- `stop`: SIGTERM, then a 3-second grace period. Timeout stays active; ordinary stop never auto-forces. `force:true` explicitly requests SIGKILL while the tracked owner remains live.
- `clear`: delete terminal records and logs, optionally by `id`; never clears a live run.

Tool transcript blocks show readable states/output rather than JSON dumps; native expansion reveals metadata. Model-facing results remain sanitized JSON. Completion/watch messages store event-time details and remain renderable after records are cleared or sessions replaced. Old messages have a safe fallback.

The **pi-processes** skill is advertised to Pi and readable via `/skill:pi-processes`. Essential tool guidelines also tell the model to use specific names, check duplicates, continue working/end its turn after start, and prefer watches over sleep/polling.

## `/processes`

| View | Keys |
| --- | --- |
| List | `j`/`k` or ↑↓ / PgUp / PgDn; Enter details; `/` search; `x` stop/force |
| Details | `j`/`k` or ↑↓ scroll; Enter logs; `x` stop/force; `s` graceful stop; `a` acknowledge; `c` clear terminal |
| Details, running | `w` single-line stdin (no newline); `e` EOF |
| Logs | `j`/`k` or ↑↓ / PgUp / PgDn pause and scroll; `f` follow; `t` stream; `/` literal search |
| Any | `?` contextual help (`j`/`k` scroll); Esc back/close |

**`x` requires confirmation:** active runs get SIGTERM; at `stop-timeout`, it offers an explicit confirmed SIGKILL. **`k` only navigates, never forces.** Details `s` remains graceful-only, even after timeout. Logs are non-destructive. Clear, stdin and EOF also require confirmation for the captured selected ID, with eligibility checked again before execution.

Configured Pi selection/input bindings remain supported. Search/stdin consume literal j/k/x and bracketed paste; input is IME-aware. The editor draft is preserved. Selection and per-run log views survive reopening in the same session. Paused logs freeze until `f` resumes. Very small terminals require resizing before controls activate. Inspect cleanup warnings in details.

Start/rerun only through the tool: the public command API cannot re-enter tool permission guards, so no direct-spawn UI workaround is used. Navigation/control feedback does not request a model turn; genuine completion/watch events keep their attention policy. RPC lists through UI notifications; headless mode uses stderr, never JSON stdout.

## Notifications and status

Success/failure default to `turn` (wake/steer); external signals default to `context` (next turn). Intentional stops always use context. `ignore` suppresses successful/external-signal completions; failure/watch ignore becomes context. Cleanup warnings remain visible.

Watches assemble **per-stream complete lines**, matching on newline or final EOF/drain flush, not necessarily immediately on unterminated readiness text. No cross-stream concatenation or historical log replay. One-shot is default; repeat watches have a **15-second cooldown**. Aggregate delivery is **20 watch notifications/minute**, with a context suppression summary. Terminal completion notifications are not throttled. Append/remove preserve matcher identities; replace/clear reset them. Lines over 10,000 characters are skipped; oversized lines and high-volume event buffers can drop matches. This is not lossless log monitoring. Index delivery additionally deduplicates the most recent 4096 event keys per session, not a second throttle.

The default footer shows green **N active** and red **N failed** (unacknowledged failures), hiding zero segments. Acknowledgment changes attention, not outcome; counts describe retained records, not permanent failure history.

To replace only the default status renderer, set `<agent-dir>/processes.json` and reload:

```json
{"defaultStatus":false}
```

Tools, notifications and versioned read-only snapshots remain enabled. Subscribe **before** requesting the initial snapshot:

```ts
const renderV1 = (snapshot) => {
  if (snapshot?.version === 1) render(snapshot);
};
const off = pi.events.on('processes:snapshot:v1', renderV1);
pi.events.emit('processes:snapshot:request:v1', {
  version: 1, reply: renderV1,
});
// On subscriber shutdown:
off();
```

Payload stays `{version:1, revision, runs, active, unacknowledgedFailed}`. Replies/broadcasts contain detached display-safe data; receiver faults cannot interrupt handling. The bus exposes no manager or process controls. No footer replacement or global shortcut is installed.

## Ownership, logs and limits

New/resumed/forked/reloaded/closed sessions end ownership. Cleanup attempts bounded TERM/KILL of still-owned live groups and removes owned logs; failures are reported. Nothing is restored from history. No daemon, cross-session authority, automatic restart, PTY, or cleanup guarantee after abrupt host death. POSIX only; Windows unsupported.

**Terminal means the tracked shell exited, not that all descendants terminated.** Observed owner exit permanently revokes group signals and liveness probes, avoiding stale/reused group targeting. Inherited pipes still open after **200 ms** are closed with a retained descendant warning. Background, self-daemonizing and group-escaping descendants are unsupported; fully redirected descendants cannot be detected.

Logs live in a private session-owned temporary child directory. `stdoutFile`/`stderrFile` are real readable **currently-retained raw files**, not lifetime-complete archives. They may contain secrets and terminal control bytes, rotate independently, and disappear on clear/reaping/disposal. `read` can inspect those returned paths while retained; do not render raw bytes unsanitized. Tool/transcript output is sanitized and bounded. Bounded synchronous disk operations can briefly block on slow storage.

Default cap is **64 MiB each** for stdout, stderr and combined: roughly **192 MiB/run**, not a global disk quota. Only excess **finished records above 50** become eligible for reaping after **five minutes finished**; recent/live records can exceed 50. Runtime options `logRoot`, `maxLogBytes`, explicit `maxRuns` capacity and `stopGraceMs` remain supported (programmatic, not new settings). Caller `logRoot` is a parent, never permission to delete that directory.

## Discovery and migration

`index.ts` is auto-discovered through the extensions-directory symlink. Its supported `resources_discover` hook registers the nested skill after session start and on reload; a nested Markdown file or package manifest alone would not suffice. No separate skill/settings registration is needed. Exactly one extension registers the process tool/command/message renderer and owns one runtime per session. No upstream logs/dock extensions, `/ps` aliases or interception are loaded.

Do not configure both this directory and `npm:@aliou/pi-processes`, or register this path twice. Stop old package-owned processes before removing the old package registration and restarting. Remove a separately configured same-name skill if present: Pi retains the first discovered `pi-processes` skill and reports a collision. A full restart is recommended for activation; no live settings are changed by this package.

## Source provenance

Pinned origin: **`@aliou/pi-processes` 0.12.0**, https://github.com/aliou/pi-processes, research-pinned commit **`16c1080030e5efd175a268e44ce665fb97bcb68f`**. Tar integrity: `sha512-Xf/lWTQ15M0ZJKjZrbmuhWHnJtSD5h9lQKVNJpwqy4njZhlqRwMLyJ55j16tOUDEujbTPPmZpBecBJPuQJ9R9Q==`.

[Backend provenance](backend/UPSTREAM.md) and [renderer/skill provenance](render/UPSTREAM.md) map copied sources, hashes and compatibility/safety patches. Actual upstream manager/registry/controller/log/output/watch/notification code runs behind the existing Runtime facade; it is not a renamed independent backend. The existing safe overlay/status protocol remain local.

Supplied manifest and README declare **MIT**. All supplied selected source comments/notices and exact package/README/CONTRIBUTING metadata are retained in non-discovered audit copies. The manifest supplies **no author field**, and no standalone LICENSE/COPYING/NOTICE was supplied. This is a disclosed provenance limitation; no author, copyright holder/year or permission text is invented. Local package remains private; publication is not authorized.

## Validation

Run `npm test` here with Node TypeScript stripping and installed Pi peers. No new dependency or installation is needed. Declared host peers remain `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox`; backend uses only Node built-ins/local modules. All tests, including backend tests, are in the root `*.test.ts` runner glob.

Tests isolate HOME/agent config, use bounded harmless owned children, and cover manager safety/logs/reaping/watch policies, tool JSON/human rendering, replay, controls, status opt-out/protocol, installed SDK discovery/skill advertisement/collisions/reload, headless/RPC adapters, and actual regular/fullscreen renderers with an in-memory terminal. Policy clocks avoid long real waits. Node stripping is not static typechecking. Physical-terminal keyboard/IME behavior and live activation remain manual validation.
