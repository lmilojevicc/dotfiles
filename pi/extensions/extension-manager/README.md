# Extension manager

One extension that owns user-scope extension loading for this Pi setup and provides the
`/extensions-manager` menu for turning packages and local extensions off per host without
deleting files or uninstalling packages.

Pi decides which extensions load from `~/.pi/agent/settings.json` and gives an extension no way
to unload or veto a peer that settings already enabled. So the rule here is:

> A package that is disabled anywhere (in every host, or only inside BB) is **not listed in
> `settings.json` at all**. It is owned by `extension-manager.json`, which is empty of that
> package's claim only when it is enabled everywhere again.

`settings.json` therefore stays ordinary Pi settings — plain package source strings, no filters
— and the loader (`settings.extensions` entry) loads the owned packages back in the hosts where
they are still enabled.

## Files

| File | Role |
| --- | --- |
| `loader.ts` | Pi entry (`settings.extensions`). Captures the host fact once, delegates. |
| `gate.ts` | Host decision, fail-open loading, package resources, one-time warnings. |
| `discovery.ts` | Finds packages and local entrypoints for the menu. |
| `config.ts` | Reads/writes the tracked package-level scopes. |
| `state.ts` | Staging model and the settings/config plan for a save. |
| `settings.ts` | The only settings.json write path (through `SettingsManager`). |
| `index.ts` | `/extensions-manager`: two tabs, staging, saving, `update`. |
| `component.ts` | Tabbed, searchable TUI component. |
| `extension-manager.json` | Tracked config: which scope disables each owned package. |

## Configuration

`extension-manager.json` beside `loader.ts` holds package-level scopes. The value names the
scope a source is disabled in; an absent source is enabled everywhere and lives in
`settings.json`.

```json
{
  "packages": {
    "git:github.com/MasuRii/pi-tool-display": "bb",
    "npm:pi-interactive-shell": "bb",
    "npm:pi-subagents": "bb"
  },
  "extensions": {}
}
```

- `global` — off in every host: never loaded, never resolved.
- `bb` — off when launched from BB. A nonblank `BB_THREAD_ID` means BB; the value is read once,
  before any `await`, so later environment changes need `/reload` or a new runtime. Every other
  launch is ordinary Pi, where the loader loads the package.
- `extensions` — the same mapping for *local* extension ids (`extensions/usage/index.ts`). It is
  only needed for local entrypoints Pi must skip everywhere, expressed as one `-path` line in
  `settings.extensions` (see below). Today it is empty.

Unknown ids are preserved across saves, so a temporarily uninstalled package or a removed local
extension keeps its entry. Edit the file directly and `/reload`, or use the menu.

## Menu

1. Run `/extensions-manager`.
2. **Tab** switches between **Pi (global)** and **BB** (Shift+Tab goes back), matching Pi's
   native `pi config` scope key.
3. Type to search by source or path. Pi's configured selection keys move and page.
4. Enter toggles the selected row in the current tab; Space also toggles when the search field is
   empty.
5. `ctrl+s` saves both tabs at once. Escape asks before discarding staged changes.

Rows are packages (the source string) and local extensions (their agent-relative entrypoint
path). One scope per row covers both tabs: the global tab shows whether the row is on at all,
the BB tab whether it is on inside BB. The BB tab shows globally disabled rows as
`off globally`: they stay unavailable there until the global tab re-enables them. An owned
package whose install is missing is marked `not installed` and stays toggleable.

A package that `pi install` (or a hand edit) puts back into `settings.json` is loaded by Pi in
every host, so it is reported as enabled everywhere and its tracked scope is dropped by the next
save; settings keeps its plain string.

What a save means per row:

| From | To | Effect |
| --- | --- | --- |
| enabled everywhere | disabled | source string leaves `packages` in `settings.json`, `extension-manager.json` records the scope |
| owned (`global`/`bb`) | enabled everywhere | source is appended to `packages` again as a plain string, config entry removed |
| owned `bb` | owned `global` (or back) | only `extension-manager.json` changes |

Local extensions cannot be filtered per package, so Pi can only skip them through a `-path`
entry in `settings.extensions`. Disabling one therefore adds exactly one
`-extensions/<path>` line (global: Pi skips it; bb: Pi skips it and the loader loads it in non-BB
hosts) and records the scope in `extension-manager.json`; re-enabling removes the line. The
manager itself is locked (`required`) and is never written into either file.

RPC clients get the same model through `ctx.ui.select`: rows show the current tab's state, a
`Switch to …` action changes tab, and **Save changes** persists both files.

Reload Pi (or `/reload`) for a save to take effect; the running session keeps its
already-loaded extensions.

## How settings and the loader divide work

`settings.json` lists this loader as its only user-scope extension entry, `-builtin:mcp`, and
every package that is enabled everywhere as a plain source string. Pi loads those packages
(skills, prompts, themes and extensions) natively; the manager itself is an ordinary
auto-discovered local extension. The loader adds, only in hosts where they are still enabled:

- the extensions of owned packages, resolved through Pi's own package manager against an
  in-memory settings view, so extensions, skills, prompts and themes match a native install;
- package skills, prompts and themes, contributed through the `resources_discover` hook;
- local entrypoints that settings skip but the config keeps for non-BB hosts.

Nothing is loaded for the scope that disabled a row, and the manager always loads as an ordinary
local extension so `/extensions-manager` stays reachable.

### Safeguards

- **Installed-path pre-flight.** An owned package is resolved only when its install already
  exists; otherwise the loader warns and resolves nothing.
- **No install, clone or reconcile side effects.** Package resolution uses
  `onMissing: "skip"`, and pinned sources (`npm:name@version`, `git:…#ref`) are refused with a
  warning, because Pi's resolver could otherwise install or reconcile them. List packages
  unpinned.
- **Fail-open with visible warnings.** A missing install, broken entrypoint or malformed config
  warns once per runtime through `ctx.ui.notify` (or stderr headlessly) at `session_start`, or at
  the first `before_agent_start` if no start event fired. Siblings still load and the loader
  itself never throws.
- **No environment or settings mutation at load.** Only `BB_THREAD_ID` is read (once), and the
  loader writes no file at all.
- **Settings still wins.** An owned source that reappears in `settings.json` `packages` is
  resolved by Pi before the loader runs, so the loader skips it with a warning instead of
  registering its extensions twice, and `/extensions-manager` reports the stale scope.

## Updates

`pi update` only reconciles sources listed in `settings.json`, so owned packages would silently
never update. `/extensions-manager update` runs Pi's own update pass against an in-memory
settings view holding exactly the owned sources: unpinned npm packages go to latest, pinned git
refs are reconciled, and Pi skips pinned npm versions by design. Reload afterwards to apply.

## Removing a package from settings.json does not uninstall it

Verified against Pi 1.3.0: editing a source out of `settings.json` only stops Pi from loading it.
The install directory (`~/.pi/agent/npm/node_modules/<name>` or `~/.pi/agent/git/…`) stays
exactly as it is, and a package removed from settings and later re-added keeps its files.
`uninstallNpm` / `removeGit` are reachable only through `pi remove` (or `removeAndPersist`), so
the manager's add/remove of plain strings cannot delete anything. That is what makes this
ownership scheme safe and cheap to roll back.

## Limitations

- Disabling a package hides its extensions, skills and prompts for that host, but not its themes
  and skills inside an already-running session: reload to apply, and note that Pi's resource
  loader only ever *extends* its path list, so a package that was loaded earlier in the same
  process can keep contributing until a fresh `pi` process.
- Project-scope resources, `pi -e <path>`, and manual launches outside `settings.json` bypass the
  loader. This is host routing for one environment, not authentication or isolation.
- Owned packages load at the loader's position in the load order, not their former position.
- Child sessions created by pi-subagents load through their own required-extension snapshot, so
  they do not inherit this split.
- Keep owned sources in user scope only: a project `.pi/settings.json` that lists an owned package
  would load it twice. Only the global package list is guarded against that.
- Object-form package entries in `settings.json` are honoured while enabled and never written:
  disabling such a package drops the whole entry (filters included), and re-enabling appends a
  plain string.
- A hand-written `-extensions/extension-manager/index.ts` in `settings.json` would hide the menu;
  the manager never writes one, and the loader refuses a tracked config entry that names it.
  Remove such a line to recover.

## Migration and rollback

Migration from the earlier filter-everything scheme removed the `-extensions/…` filters and the
per-package `extensions: []` entries, restored plain package strings in their original order, and
moved the three BB-disabled packages (`npm:pi-subagents`, `npm:pi-interactive-shell`,
`git:github.com/MasuRii/pi-tool-display`) into `extension-manager.json` as `bb`. The removed
`npm:@narumitw/pi-goal` entry is gone.

Rollback: add the owned sources back to `settings.json` as plain strings, delete
`extension-manager.json`, and remove the loader from `settings.extensions`. `pi remove` any
package you actually want uninstalled.

## Tests

```sh
npm --prefix pi/extensions/extension-manager test
```

`node --test` (with a temporary `PI_CODING_AGENT_DIR`) covers config parsing, discovery,
scope/staging math, plan generation, BB vs non-BB loading with fixtures, contributed package
skills/prompts, pinned and missing-install refusing, stale scopes for sources settings lists again,
the two tabs, staged/cancel flows, RPC
scope switching, self-protection, `update`, persistence failures, and never writing settings.json
on a config-only change. Tests assert behaviour with fixtures, never the contents of the user's
real `settings.json` or `extension-manager.json`.
