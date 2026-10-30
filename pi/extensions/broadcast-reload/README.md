# Broadcast Reload Extension for Pi

Safely reload all active `pi` sessions across projects with a single command without disrupting running agents.

## Overview

Pi runs each interactive session as an independent process. By default, running `/reload` only reloads the current session.

The `broadcast-reload` extension registers a local IPC listener for each running session and exposes `/broadcast-reload` to coordinate reloading across all running Pi sessions on the same machine.

Sessions **without** this plugin used to be unreachable. They no longer are: under Herdr, `/broadcast-reload` also reaches plugin-less sessions by typing `/reload` into their panes (idle panes only — see safety model below).

## Safety Guarantee

When a broadcast reload is triggered:
- **Idle plugin sessions** (`ctx.isIdle()` is true, no pending messages or active runs) reload immediately over the socket.
- **Busy plugin sessions** (agent actively streaming, executing tools, waiting for background processes, or running multi-turn tasks) will **not** be interrupted. Instead, the reload is safely deferred. As soon as the current agent task completes and settles (`agent_settled`), the session applies the reload automatically. This also applies to `/broadcast-reload --force`: Pi itself refuses to reload while a session is streaming or compacting, so a forced reload of a busy session is queued rather than lost — it is never reported as "reloaded" before it actually ran.
- **Idle plugin-less sessions under Herdr** (no socket, but visible as an `idle` pi pane) get `/reload` typed into their pane via `herdr pane send-text` + `send-keys Enter`. The pane's status is re-checked immediately before each injection, so a session that started working after the scan is skipped instead of polluted.
- **Working or unknown-status Herdr panes are NEVER injected into** — not even with `--force`. Pi routes submitted text to the LLM as a steered/follow-up message while streaming, so injecting `/reload` there would pollute the agent's context instead of reloading. These panes are reported; re-run `/broadcast-reload` once they settle.
- **Blind injection is refused**: if the sender's own pane cannot be identified (`herdr pane current` fails), no keystrokes are sent anywhere — candidates are reported for manual `/reload` instead.
- **No coverage assumptions**: a pane whose process cannot be PID-correlated to a plugin session is never assumed covered — not even when its cwd matches a socket session. Twin sessions in the same repo (one with the plugin, one without) each get their own verdict; the uncorrelated twin is reported for manual `/reload`. A duplicate `/reload` into an idle pane is harmless; a silently missed session is not.

## Usage

In any active Pi session:

```text
/broadcast-reload
```
Safely broadcasts the reload to all other active Pi sessions (deferring busy ones), then reloads the current session — or queues that reload if this session turned busy meanwhile.

### Options

- `/broadcast-reload --status` (or `-s`):
  Inspect the unified session view without reloading: plugin sessions (sockets) with PIDs and idle/busy state, Herdr pi panes with plugin yes/no and idle/working status, and stray pi processes that need manual `/reload`.

- `/broadcast-reload --force` (or `-f`):
  Skip the "current session is busy" refusal: the broadcast runs even when this session is working, and this session reloads as soon as Pi accepts a reload (immediately, or queued until the current run settles). Busy peer sessions are still never interrupted — they queue the reload and apply it at `agent_settled`. `--force` never force-injects into working or unknown-status Herdr panes.

- `/broadcast-reload --help` (or `-h`):
  Show help and available flags.

## Architecture

Three layers, in order:

1. **Socket IPC (plugin sessions)**: Fast, lightweight local UNIX domain sockets (or named pipes on Windows) stored under `~/.pi/agent/broadcast-reload/sockets/<pid>.sock`. On Windows the pipe is `\\.\pipe\pi-broadcast-reload-<pid>` and a `<pid>.sock` marker file in that directory makes it discoverable (a named pipe has no directory entry), so discovery, PID liveness checks, stale cleanup and `PI_BROADCAST_RELOAD_DIR` work there too. Safe in-process reload with busy-deferral via `agent_settled`.
2. **Herdr pane fallback (plugin-less sessions)**: `herdr pane list` enumerates pi panes; each pane is correlated to a process via `herdr pane process-info` and matched against socket-covered PIDs (plus the sender PID/pane, which are always excluded). Idle, uncorrelated panes get `/reload` typed in. Requires `HERDR_ENV=1` and a working `herdr` CLI; otherwise this layer is skipped and behavior is socket-only, as before.
3. **Process-discovery sweep**: a `ps`-based scan finds pi PIDs with no socket and no Herdr pane. These cannot be reloaded from here and are reported for manual `/reload`.

- **Automatic Garbage Collection**: Unresponsive or dead sockets from crashed processes are automatically identified and cleaned up.
- **Zero Token Overhead**: Direct process-to-process IPC plus terminal input. Does not inject prompts into LLM context.

## Requirements & limitations

- Herdr fallback needs the `herdr` CLI on PATH and `HERDR_ENV=1`. Without either, the extension degrades gracefully to socket-only behavior.
- A degraded layer is always reported: if `herdr pane list` fails or the `ps`/`tasklist` sweep cannot run, both the reload summary and `--status` say so instead of implying every session was reached. Those blind spots are exactly the sessions that need a manual `/reload`.
- `unknown`-status panes, panes whose process cannot be correlated, and non-Herdr plugin-less sessions are reported for manual `/reload` — never injected into.
- If a pane injection half-submits (`send-text` succeeded but `send-keys` failed), the extension attempts an Escape cleanup and reports the outcome. Residual-input limitation: Escape may not clear the editor in every TUI state, so a failed injection can still leave a typed-but-unsubmitted `/reload` line in the foreign pane — check the reported pane if an injection is reported as failed.
- `ps` matching is conservative: helpers such as the pi-intercom broker, tsx, and esbuild are excluded; transient `pi -p` one-shots may appear as manual entries.
