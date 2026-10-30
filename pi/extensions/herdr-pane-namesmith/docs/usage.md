# Herdr pane namesmith

Keeps the **current Pi pane's Herdr label** equal to its Pi session name. It follows manual `/name <name>` and automatic `pi.setSessionName()` calls (including `session-auto-rename`), and synchronizes saved names on startup, `/reload`, `/resume`, `/new`, and `/fork`. Clearing the name clears the pane label **only if this Pi runtime wrote that label**; an unnamed session and a pane label written by the user or by another tool are left alone. `/name` without an argument only displays the current name; extensions can clear it with `pi.setSessionName("")`.

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

`label: null` clears. JSON preserves spaces, quotes, Unicode, and literal option-like labels such as `--clear`. **No shell or Herdr CLI is executed.** Herdr 0.9.5's rename CLI treats `--` as label text, so a CLI delimiter cannot safely preserve exact labels; the socket API is used instead. Windows pipe names follow the existing Herdr Pi integration's `\\.\pipe\` normalization.

Requests are serialized; only the newest pending name survives a burst. Only acknowledged successes deduplicate within an active burst. Once the queue is idle, repeating `/name <name>` or clearing the name reapplies the label even if it was edited manually in Herdr. Failures remain nonfatal, emit one concise warning per failure streak (reset by success, or by a different pane/name), and are retried without a polling timer: the next `agent_settled` re-attempts the failed name once, as does any later name/session event. Each request has a 2-second wall-clock deadline and a 16-KiB response limit; it requires a matching response ID, a result object, and no error. Fragmented responses are buffered until newline. Every settlement destroys the socket.

`pane.get` (same transport, deadline, and framing) is used before exit cleanup to read the pane's current label.

`session_shutdown` drops pending work and waits for the bounded in-flight request to settle before Pi invalidates the old context. On normal Pi exit (`reason: "quit"`), it reads the label on the last own pane/socket this TUI runtime wrote and clears it only when that label is still the one Pi wrote, even if that write's response was lost. Cleanup uses the captured identity, not later environment changes, focused panes, or discarded pending targets. A label changed in Herdr during the session, a label written by another tool or a nested Pi process, and a pane whose label cannot be read are all left untouched. Inactive and non-TUI runtimes never clear a parent pane. Repeated/concurrent shutdown calls share one awaited cleanup.

Exit cleanup is bounded and best effort: the ownership read and the clear use the same 2-second transport deadline, after any in-flight request settles, and failures remain nonfatal without notifying the stopped TUI. Forced kill, crash, or power loss cannot guarantee cleanup. No previous manual label is restored. Reload and session replacement (`reload/new/resume/fork`) do **not** clear in the old runtime; they create fresh extension factories that read the current name on `session_start` without retaining old queue/dedup state, which also means a fresh runtime has no label of its own and therefore never clears a pane on an unnamed session.

## Tests and contract sources

```sh
npm --prefix pi/extensions/herdr-pane-namesmith test
```

Uses only Node's native TypeScript support and `node:test` (a Node release with native TypeScript support is required; verified with Node 26.10.0). No dependencies, sleeps, polling, real Herdr calls, or global changes.

Checked against installed Pi 1.4.0:

- `docs/extensions.md`, plus pertinent `configuration.md`, `settings.md` (resources), `packages.md`, `security.md` (trust), `cli.md` (resources/modes), and `sessions.md`: directory discovery, manifest paths, terminal-only mode guard, context invalidation and cleanup.
- `dist/core/extensions/types.d.ts`: normalized `session_info_changed.name` (`string | undefined`); start reasons `startup/reload/new/resume/fork`; shutdown reasons `quit/reload/new/resume/fork`; `agent_settled` (`{aborted}`) and its notification-style settlement contract; `pi.getSessionName`.
- `dist/modes/interactive/interactive-mode.js`, `handleNameCommand`: `/name` uses `session.setSessionName`; normal interactive `shutdown` awaits `runtimeHost.dispose()` before `process.exit(0)`.
- `dist/core/agent-session.js`, `setSessionName` and extension bindings: both manual and API naming emit the metadata event; reload awaits shutdown, replaces the runtime, then emits start.
- `dist/core/agent-session-runtime.js`, `teardownCurrent` and session replacement methods: await shutdown before creating/rebinding the replacement runtime; `dispose` awaits `session_shutdown` with reason `quit` (via `emitSessionShutdownEvent`) before invalidating the session.
- `dist/core/extensions/loader.js`, `resolveExtensionEntries`: `pi.extensions` manifest first, `index.ts` fallback; no recursive test discovery. A read-only installed-loader check discovered exactly `index.ts` with the four lifecycle handlers and zero errors/warnings, without starting a session.

Herdr 0.9.5 (client) / 0.9.3 (running server) `pane.rename` and `pane.get` envelopes were verified against the bundled API schema (`herdr api schema --json`) and a temporary pane: `pane.get` takes `{pane_id}` and replies `{type: "pane_info", pane}` with `PaneInfo.label` (`string | null`, omitted for an unlabeled pane), which is what exit cleanup reads; `pane.rename` uses the same envelope, so the read and the clear share one transport. The temporary pane also confirmed that Unicode labels survive and that a cleared label reads back as no label. No worker tests touch live Herdr. Future protocol changes and actual Windows runtime behavior remain outside these unit tests.
