# Herdr pane namesmith

Keeps the **current Pi pane's Herdr label** equal to its Pi session name. It follows manual `/name <name>` and automatic `pi.setSessionName()` calls (including `session-auto-rename`), and synchronizes saved names on startup, `/reload`, `/resume`, `/new`, and `/fork`. An unnamed or cleared session clears the pane label. `/name` without an argument only displays the current name; extensions can clear it with `pi.setSessionName("")`.

**While active, this deliberately overrides manual Herdr pane labels on name/session synchronization.** It does not monitor Herdr label edits or restore the previous label on exit. Remove/disable the extension and reload Pi to stop synchronization.

## Load

Try it for one invocation from this repository:

```sh
pi --extension ./pi/extensions/herdr-pane-namesmith
```

For automatic loading, put this directory under `~/.pi/agent/extensions/` (or a trusted project's `.pi/extensions/`), or add its absolute directory path to Pi's `extensions` settings. The package's `pi.extensions` manifest exposes only `index.ts`; tests and docs are not extension entries. No runtime dependencies or installation step are needed. This repository's `pi/extensions/` is not itself Pi's conventional `.pi/extensions/` location. Reload with `/reload` after changing extension files/settings. No settings are changed by this extension.

## Safety and lifecycle

Synchronization requires all of:

- `ctx.mode === "tui"` (not merely `hasUI`; RPC can have UI).
- `HERDR_ENV=1`.
- Nonempty `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`.

Inherited-env RPC/JSON/print child processes never rename the parent pane. Requests always use the pane ID and socket supplied to **this process**, never the focused pane.

The asynchronous Node socket transport sends newline-delimited JSON:

```json
{"id":"unique-request-id","method":"pane.rename","params":{"pane_id":"own-pane-id","label":"Pi session name"}}
```

`label: null` clears. JSON preserves spaces, quotes, Unicode, and literal option-like labels such as `--clear`. **No shell or Herdr CLI is executed.** Herdr 0.9.1's rename CLI treats `--` as label text, so a CLI delimiter cannot safely preserve exact labels; the socket API is used instead. Windows pipe names follow the existing Herdr Pi integration's `\\.\pipe\` normalization.

Requests are serialized; only the newest pending name survives a burst. Only acknowledged successes deduplicate within an active burst. Once the queue is idle, repeating `/name <name>` or clearing the name reapplies the label even if it was edited manually in Herdr. Failures remain nonfatal, emit one concise warning per failure streak (reset by success), and retry on a future name/session event, not a polling timer. Each request has a 2-second wall-clock deadline and a 16-KiB response limit; it requires a matching response ID, a result object, and no error. Fragmented responses are buffered until newline. Every settlement destroys the socket.

`session_shutdown` drops pending work and waits for the bounded in-flight request to settle before Pi invalidates the old context. It does not clear or restore the label on shutdown. Reload and session replacement create fresh extension factories; those read the current name on `session_start` without retaining old queue/dedup state.

## Tests and contract sources

```sh
npm --prefix pi/extensions/herdr-pane-namesmith test
```

Uses only Node's native TypeScript support and `node:test` (a Node release with native TypeScript support is required; verified with Node 26.10.0). No dependencies, sleeps, polling, real Herdr calls, or global changes.

Checked against installed Pi 1.0.4:

- `docs/extensions.md`, plus pertinent `configuration.md`, `settings.md` (resources), `packages.md`, `security.md` (trust), `cli.md` (resources/modes), and `sessions.md`: directory discovery, manifest paths, terminal-only mode guard, context invalidation and cleanup.
- `dist/core/extensions/types.d.ts`: normalized `session_info_changed.name`; start reasons `startup/reload/new/resume/fork`; shutdown reasons `quit/reload/new/resume/fork`.
- `dist/modes/interactive/interactive-mode.js`, `handleNameCommand`: `/name` uses `session.setSessionName`.
- `dist/core/agent-session.js`, `setSessionName` and extension bindings: both manual and API naming emit the metadata event; reload awaits shutdown, replaces the runtime, then emits start.
- `dist/core/agent-session-runtime.js`, `teardownCurrent` and session replacement methods: await shutdown before creating/rebinding the replacement runtime.
- `dist/core/extensions/loader.js`, `resolveExtensionEntries`: `pi.extensions` manifest first, `index.ts` fallback; no recursive test discovery. A read-only installed-loader check discovered exactly `index.ts` with the three lifecycle handlers and zero errors/warnings, without starting a session.

Herdr `pane.rename` request/result envelopes were verified by the parent against installed Herdr 0.9.1 schema and a temporary pane, including exact `--clear`, quoted Unicode labels, and null clearing. No worker tests touch live Herdr. Future protocol changes and actual Windows runtime behavior remain outside these unit tests.
