# Processes

Session-owned shell commands with the `process` tool and `/processes` overlay.

## Use

Start commands through the **process tool**. For example:

```json
{"action":"start","name":"tests","command":"npm test","notify":{"onSuccess":"context"}}
```

Use the returned opaque `id` for `output`, `write`, `update`, and `stop`. `cwd` defaults to the agent's working directory. Commands receive pipes, not a PTY. Keep the command in the foreground: do not append `&`, daemonize, or detach descendants.

- `list`: retained runs, with `phase`, `outcome`, and a compatibility `status`.
- `output`: retained tail (100 lines by default, at most 2000 / 50 KiB). `stream` selects `stdout`, `stderr`, or `both`; `pattern` is a literal filter. Rotation/truncation is marked.
- `write`: exact `input`, no automatic newline; `end:true` explicitly closes stdin. Maximum payload: 50 KiB.
- `update`: rename or append/replace/remove/clear log watches. At most 20 watches, 500 characters per pattern. **Regex is unsupported and rejected**, including legacy `mode:"regex"` requests.
- `stop`: SIGTERM, then a 3-second grace period. A timeout stays active. `force:true` explicitly sends SIGKILL only while the tracked owner is still live.
- `clear`: delete terminal records and their logs; optional `id`, otherwise all terminal records. Never clears a live run.

Legacy list filters and the five sort names remain available. `failed` includes stop timeouts and failed outcomes even after acknowledgment; `killed` means signal-ended terminal runs. The default list limit is 100, maximum 10000.

## `/processes`

| View | Keys |
| --- | --- |
| List | ↑↓ / PgUp / PgDn, Enter details, `/` search |
| Details | Enter logs, `s` stop, `k` force after timeout, `a` acknowledge failure, `c` clear terminal |
| Details, running | `w` single-line stdin (no newline), `e` EOF |
| Logs | ↑↓ / PgUp / PgDn pause and scroll, `f` follow, `t` stream, `/` literal search |
| Any | `?` contextual help, Esc back/close |

The table shows default navigation bindings; configured Pi selection/input bindings are honored. Stop, force, clear, stdin, and EOF require confirmation for the selected run. Search and stdin use an IME-aware input. The overlay leaves the editor draft untouched. Selection and per-run log views survive reopening within the session. Paused logs freeze the displayed tail; `f` resumes with the latest retained output. Very small terminals require resizing before controls are enabled.

**Start/rerun via process tool.** UI start/rerun are unsupported in v1 because the public command API cannot re-enter tool permission guards. No direct-spawn workaround is used. Immediate UI navigation/control feedback never requests a model turn. Genuine process completion/watch notifications retain their configured policy, including events caused by UI stdin or EOF. Non-TUI invocation lists runs through notifications (RPC) or stderr (headless), without opening a custom component or writing into JSON stdout.

The footer shows green **N active** and red **N failed** (unacknowledged failures). Zero segments disappear; an empty status is hidden. Acknowledgment changes attention only, not outcome or failure history. Inspect `Warning` in details when a run has a cleanup error; ↑↓ scroll long details.

## Notifications and status integration

Success and failure default to `turn` (wake/steer). External signals default to `context` (next turn). Intentional-stop completions always use context; other completion/watch events keep their policy regardless of whether a UI action is pending or finished. `ignore` suppresses successful exits and external-signal notices; failure/watch ignore becomes context. Cleanup warnings remain visible. Watches fire once unless `repeat:true`; repeats coalesce to at most once per watch per second. The adapter additionally deduplicates the most recent 4096 notification keys per session.

To use another status renderer, put this in `<agent-dir>/processes.json`, then reload:

```json
{"defaultStatus":false}
```

This disables only this extension's status, not tools, notifications, or the read-only event protocol:

- Request `processes:snapshot:request:v1` with `{version:1, reply(snapshot) { ... }}`.
- Subscribe to `processes:snapshot:v1` for version-1 snapshots.

Subscribe before requesting the initial snapshot. Replies and broadcasts contain detached display-safe data. Receiver faults cannot interrupt process handling. No runtime controls are exposed on the bus. There is no footer replacement or global shortcut.

## Ownership and limits

New, resumed, forked, reloaded, or closed sessions end ownership: cleanup attempts to stop owned processes and remove their logs. Nothing is restored from session history. Cleanup failures are reported, not treated as successful termination. Retained logs are private temporary files, bounded to 1 MiB per stream by default; at most 100 records are retained before new starts require a clear. Logs may contain secrets until cleared or disposed.

**Terminal means the tracked shell exited, not that all descendants terminated.** No group signals are sent after that shell's observed exit, avoiding reused-group targeting. Inherited output pipes still open after 200 ms are closed with a retained warning that descendants may still be running. Background, self-daemonizing, and group-escaping descendants are unsupported; fully redirected descendants cannot be detected. No daemon, cross-session control, automatic restart, or cleanup guarantee after abrupt host death is provided. Bounded synchronous log writes may briefly block on slow storage.

This directory's `index.ts` is auto-discovered through the extensions directory; do not add a second package/path registration. It replaces `npm:@aliou/pi-processes`. Its `/ps` commands, dock, and skill are not retained. Stop old package-owned processes before removing that package from settings and restarting with the replacement.

## Validation

Run `npm test` here with Node's TypeScript stripping support and Pi installed. The test loader resolves installed Pi dependencies and isolates HOME/agent configuration in temporary directories; no dependency installation or live session is required. Tests exercise owned harmless children, extension discovery/registration, headless behavior, and regular/fullscreen rendering with an in-memory terminal. Real terminal keyboard/IME behavior still requires manual verification.
