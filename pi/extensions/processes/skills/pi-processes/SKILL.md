---
name: pi-processes
description: Manage long-running commands with the process tool. Use when a task needs a dev server, watcher, build, test watcher, local API, log tail, or other command to keep running while the conversation continues.
---

# pi-processes

Use the `process` tool for commands that should keep running while the agent continues working. Do not use shell background patterns such as `&`, `nohup`, `disown`, or `setsid` when `process` fits.

## The core loop: start, do not wait, get notified

A started process runs under this Pi session and notifications bring you back when something happens. You do not need to sleep, poll, or hold your turn for a process to finish. No daemon, PTY, automatic restart, cross-session adoption, or control of processes you did not start here.

1. `process start` a long-running command, with `notify.logMatches` for the signals you care about.
2. End your turn or move on to other work. Do not call `process output` in a loop waiting for "ready".
3. The process notifies you when:
   - a `logMatches` pattern hits (readiness, error, progress),
   - the process exits successfully (`onSuccess`, default `turn`),
   - the process fails or crashes (`onFailure`, default `turn`; failures always notify),
   - the process is killed externally (`onKilled`, default `context`),
   - you stop the process intentionally (always `context`; notify config does not apply).
4. When a watch is too noisy or wrong, fix it with `process update` — do not restart the process just to change watches.
5. `process stop` obsolete live processes and `process clear` finished entries when they are no longer useful.

The only reason to wait after `process start` is when the next step literally cannot proceed until the process is ready, and even then prefer a `logMatches` watch over polling.

## Actions

### `process start`

Starts a managed process.

Use it for dev servers, test watchers, build watchers, long-running log tails, local APIs, and other commands that should continue while the conversation moves on.

Good:

```json
{
  "action": "start",
  "name": "web-dev",
  "command": "pnpm dev",
  "cwd": "/path/to/project",
  "notify": {
    "onSuccess": "context",
    "onFailure": "turn",
    "logMatches": [
      { "pattern": "ready", "mode": "literal", "stream": "both" },
      { "pattern": "EADDRINUSE", "mode": "literal", "stream": "stderr", "on": "turn" }
    ]
  }
}
```

`onSuccess: "context"` here because a dev server exiting cleanly needs no immediate reaction; the result becomes context on the next user prompt. Keep the default `turn` for builds, tests, and other one-shot commands whose result you need immediately.

Optional `cwd` sets the working directory for the spawned command. Omit it to inherit the agent's current working directory.

Empty `logMatches` patterns are rejected. Only literal matching is supported: regex is rejected by start, update, and output, including legacy requests. Scope by `stream` to cut noise, and use `repeat: true` for repeated matches (15-second cooldown). Watches assemble each stream into lines; a match fires on newline or final EOF flush, not necessarily as soon as an unterminated readiness marker is printed. Lines over 10,000 characters are skipped, and oversized/high-volume event lines may be dropped. Watches do not replay existing output.

Bad:

```bash
pnpm dev &
nohup pnpm dev >/tmp/dev.log 2>&1 &
```

### `process list`

Shows session-owned retained processes and currently readable stdout/stderr file paths, if still retained. Use returned opaque IDs, not names, PIDs, or examples below.

Use it before `process start` when a duplicate process would be harmful or noisy. Do not repeat the visible process table back to the user unless you need to explain a decision.

Optional filters:

- `statuses`: `all`, `running`, `finished`, `failed`, `terminating`, `terminate_timeout`, `killed`
- `sortBy`: `startTime_desc`, `startTime_asc`, `name_asc`, `name_desc`, `status_asc`
- `limit`: maximum number of processes to return

Good:

```json
{ "action": "list", "statuses": ["running"] }
```

```json
{ "action": "list", "statuses": ["failed", "killed"], "sortBy": "startTime_desc", "limit": 10 }
```

Bad:

```text
Starting another dev server without checking whether one is already running.
```

### `process output`

Reads recent stdout/stderr from one process.

Use it for targeted literal `pattern` checks, not a polling loop. The tail defaults to 100 lines, allows at most 2,000, scans at most 5,000 filtered lines, and returns at most 50 KiB of text (tail read budget 2 MiB); rotation and truncation flags matter. For deeper inspection use `read` on returned stdoutFile/stderrFile paths while they are still retained; these are currently-retained files, not permanent archives, and raw files can contain secrets and control bytes, may already have rotated, and disappear on clear, reaping, or session shutdown. Never treat them as lifetime-complete logs. Do not fetch output solely to repeat a completion notification.

Good:

```json
{
  "action": "output",
  "id": "<returned-opaque-id>",
  "stream": "stderr",
  "pattern": "EADDRINUSE",
  "mode": "literal"
}
```

Bad:

```text
Calling process output every few seconds waiting for "ready".
```

Use watches instead:

```json
{
  "action": "update",
  "id": "<returned-opaque-id>",
  "watches": {
    "mode": "append",
    "items": [{ "pattern": "ready", "mode": "literal" }]
  }
}
```

### `process update`

Renames a running process or changes its watches. Update only works while the process is running.

Use it instead of restarting a process just to add, remove, or replace watch patterns. You can change `name` and `watches` in the same call.

`watches.mode` controls how the `items` are applied:

- `append` — add the items to the existing watches.
- `replace` — replace all watches with the items.
- `remove` — remove specific watches. Identify each by `index`, or by `pattern` (index takes precedence when both are given).
- `clear` — remove all watches. `items` is ignored.

Good:

```json
{
  "action": "update",
  "id": "<returned-opaque-id>",
  "name": "api-dev",
  "watches": {
    "mode": "append",
    "items": [
      { "pattern": "Server listening", "mode": "literal" },
      { "pattern": "EADDRINUSE", "mode": "literal", "stream": "stderr" }
    ]
  }
}
```

Bad:

```text
Stopping and restarting a server only to add a readiness matcher.
```

### `process write`

Sends bytes to a running process's stdin.

Use it to drive interactive servers, REPLs, and CLIs that expect input after they start. Pass `input` for the bytes to write, and set `end: true` to close stdin (for example to signal EOF to a waiting process).

Good:

```json
{ "action": "write", "id": "<returned-opaque-id>", "input": "quit\n" }
```

```json
{ "action": "write", "id": "<returned-opaque-id>", "end": true }
```

Bad:

```text
Writing with no `input` and no `end` (a no-op). The tool rejects it.
```

### `process stop`

Stops a managed process with SIGTERM. If the tracked owner does not exit before the timeout, it remains active; there is no automatic SIGKILL. Only an explicit `{ "action": "stop", "id": "<returned-opaque-id>", "force": true }` sends SIGKILL while that owner is still live. Never signal a stale group after owner exit. Terminal status refers to the tracked shell, not guaranteed descendant cleanup.

Use it when a process is obsolete, blocking a port, or no longer needed. Intentional stops suppress normal failure noise.

Good:

```json
{ "action": "stop", "id": "<returned-opaque-id>" }
```

### `process clear`

Clears finished processes and their log storage.

Use it after stopped, failed, or completed processes are no longer useful. It never clears live processes. Default logs are capped at 64 MiB each for stdout, stderr, and combined (up to roughly 192 MiB per run); these are not a global disk quota. Only excess finished entries above 50 are reaped, and only after five minutes finished; recent or live records can exceed 50. An explicit configured maxRuns still enforces capacity. Failure counts cover retained runs only.

Good:

```json
{ "action": "clear" }
```

## Notification reference

`notify` on `process start` (and watches on `process update`) control how the manager brings you back.

Exit attention:

- `notify.onSuccess` — clean exit. Defaults to `turn`.
- `notify.onFailure` — failure or crash. Defaults to `turn`; `ignore` is downgraded to `context` because failures always notify.
- `notify.onKilled` — killed from outside the tool. Defaults to `context`. Intentional stops always produce context and bypass this setting.

Log match watches (`notify.logMatches`, up to 20, each pattern up to 500 chars):

- `pattern` — required and nonempty. Literal only; regex requests are rejected.
- `mode` — `literal` (default) only.
- `stream` — `stdout`, `stderr`, or `both` (default). Scope to cut noise.
- `repeat` — `false` (default) fires once; `true` fires at most once per 15 seconds per matcher. Delivery is limited to 20 matches per minute, with a context suppression summary.
- `on` — `turn`, `context`, or `ignore`. Overrides the default attention for that watch. Defaults to `turn`.

Attention levels:

- `turn` — wakes an idle agent or steers an active run at the next safe boundary.
- `context` — queued for the next user prompt; it does not wake or steer the agent.
- `ignore` — suppresses successful-exit and external-kill notifications. Log matches are retained for the next user prompt. Failure and crash notifications are also retained because failures always notify.

Use `context` when nothing needs to happen immediately.

## Use cases

### Dev server readiness

Start a server, get brought back when it prints its ready marker, then keep working.

```json
{
  "action": "start",
  "name": "web-dev",
  "command": "pnpm dev",
  "notify": {
    "logMatches": [{ "pattern": "ready", "stream": "stdout" }]
  }
}
```

You do not wait. End your turn; the watch fires and the manager brings you back.

### Test watcher failures

Keep a watcher running and react only when a test fails.

```json
{
  "action": "start",
  "name": "vitest-watch",
  "command": "pnpm test --watch",
  "notify": {
    "logMatches": [
      { "pattern": "FAIL", "stream": "stdout", "repeat": true, "on": "turn" },
      { "pattern": "Error:", "stream": "stderr", "repeat": true, "on": "turn" }
    ]
  }
}
```

### Build errors from stderr

Watch a build watcher and surface type or compile errors as completed lines arrive.

```json
{
  "action": "start",
  "name": "builder",
  "command": "pnpm build --watch",
  "notify": {
    "logMatches": [
      { "pattern": "TypeError", "mode": "literal", "stream": "stderr", "repeat": true },
      { "pattern": "ReferenceError", "mode": "literal", "stream": "stderr", "repeat": true }
    ]
  }
}
```

### Repeatable progress markers

Watch repeated job-completion log markers, not just the first: each watch has a 15-second cooldown, and delivery is limited to 20 log-match notifications per minute. Terminal process completion notifications are not throttled.

```json
{
  "action": "start",
  "name": "worker",
  "command": "pnpm worker",
  "notify": {
    "logMatches": [{ "pattern": "job completed", "stream": "stdout", "repeat": true }]
  }
}
```

### Interactive process that needs stdin

Start a process that waits for input, drive it, then close stdin.

```json
{ "action": "start", "name": "customer-import", "command": "npm run import:customer" }
```

```json
{ "action": "write", "id": "<returned-opaque-id>", "input": "ALFKI\n", "end": true }
```

The process prints its result and exits; `onFailure`/`onSuccess` brings you back.

## When a log watch is too noisy

A watch that fires too often wastes turns. Fix it with `process update` — never restart the process just to change watches.

First, diagnose: is the pattern too broad, on the wrong stream, or repeating when it should fire once?

Then pick a `watches.mode`:

- **Tighten the pattern or scope the stream** — `replace` all watches with corrected ones.

```json
{
  "action": "update",
  "id": "<returned-opaque-id>",
  "watches": {
    "mode": "replace",
    "items": [{ "pattern": "EADDRINUSE", "stream": "stderr" }]
  }
}
```

- **Drop `repeat`** — if a repeating watch fires too often (after its 15-second cooldown), replace it with the same pattern and omit `repeat` (defaults to `false`).

- **Remove one watch** — `remove` by `index` or `pattern`.

```json
{
  "action": "update",
  "id": "<returned-opaque-id>",
  "watches": {
    "mode": "remove",
    "items": [{ "pattern": "ready" }]
  }
}
```

```json
{
  "action": "update",
  "id": "<returned-opaque-id>",
  "watches": {
    "mode": "remove",
    "items": [{ "index": 0 }]
  }
}
```

- **Retain without interrupting** — set the watch's `on` to `ignore` so matches become context on the next user prompt.

```json
{
  "action": "update",
  "id": "<returned-opaque-id>",
  "watches": {
    "mode": "replace",
    "items": [{ "pattern": "job completed", "stream": "stdout", "repeat": true, "on": "ignore" }]
  }
}
```

- **Remove all watches** — `clear`.

```json
{
  "action": "update", "id": "<returned-opaque-id>", "watches": { "mode": "clear" } }
```

## Common mistakes

### Polling output instead of setting watches

Bad:

```text
Call process output repeatedly until the server is ready.
```

Good:

```json
{
  "action": "start",
  "name": "web-dev",
  "command": "pnpm dev",
  "notify": { "logMatches": [{ "pattern": "ready", "mode": "literal" }] }
}
```

### Waiting or sleeping after start

Bad:

```text
Start a dev server, then sleep or hold the turn until it is ready.
```

Good:

```text
Start the server with a "ready" watch and end the turn. The watch brings you back.
```

### Restarting instead of updating watches

Bad:

```text
Stop and restart a process because you forgot to watch for EADDRINUSE, or because a watch is too noisy.
```

Good:

```json
{
  "action": "update",
  "id": "<returned-opaque-id>",
  "watches": {
    "mode": "append",
    "items": [{ "pattern": "EADDRINUSE", "stream": "stderr" }]
  }
}
```

### Starting duplicates

Bad:

```text
Start `pnpm dev` without checking existing process state.
```

Good:

```json
{ "action": "list", "statuses": ["running"] }
```

Then start only if needed.

### Missing common failure watches

When starting servers, consider watches for readiness and common failure signals:

- `ready`
- `listening`
- `compiled`
- `EADDRINUSE`
- `Error:`
- `UnhandledPromiseRejection`

Keep watch patterns specific enough to avoid noisy false positives.

### Re-summarizing visible tool output

Bad:

```text
The process list shows <returned-opaque-id> is running, <other-returned-id> exited, and <third-returned-id> failed...
```

Good:

```text
I'll reuse the existing `web-dev` process.
```

### Using vague names

Bad names:

- `server`
- `test`
- `watch`

Good names:

- `web-dev`
- `api-dev`
- `vitest-watch`
- `tail-app-logs`

### Leaving obsolete processes running

Stop live processes that are no longer useful, especially duplicate dev servers or commands occupying ports. Clear finished entries when they are no longer needed for debugging.

## UI and status

`/processes` opens the session-owned overview, logs, details and help. `j`/`k` navigate when not editing text; `x` requests a confirmed TERM stop, or after a stop timeout an explicitly confirmed force stop. `k` never kills. Use `process` to start and rerun; there is no `/ps`, dock, interception, or settings UI. The default footer shows green active and red unacknowledged failures, hiding zero counts. Set `<agent-dir>/processes.json` to `{ "defaultStatus": false }` to hide only the footer, not notifications, tools, or the versioned read-only snapshot bus (`processes:snapshot:v1`, request `processes:snapshot:request:v1`). Acknowledge a retained failure in `/processes` when reviewed.

Do not ask the user to start long-running commands manually. If a process needs to run, use the `process` tool.
