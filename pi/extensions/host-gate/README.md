# host gate

Explicitly configured Pi extension that loads the extension entrypoints of
configured packages **only in the hosts that allow them**.

Pi resolves which extensions to load from settings and offers an extension no way
to unload, veto or hide a peer: `ExtensionAPI` (Pi 1.1.0) exposes registration,
`getActiveTools`/`getAllTools`/`setActiveTools`, `getCommands` and hooks, nothing
else. So a package that must not load in some host cannot be enabled in
`settings.json` and suppressed later. Instead its extension resource stays
filtered in settings (its skills and prompts still load), and this gate — the only
loader for that package — decides per host.

## Configuration

`host-gate.json` beside `loader.ts` (snapshotted when each runtime is created:
edit it and `/reload`):

```json
{
  "packages": {
    "npm:pi-subagents": { "require": ["pi"] },
    "npm:pi-interactive-shell": { "require": ["pi"] }
  }
}
```

Host conditions, ANDed per package:

| Condition | True when |
| --- | --- |
| `bb` | `BB_THREAD_ID` is a nonblank string (any format; whitespace-only counts as absent) |
| `pi` | the complement of `bb` |
| `tui` | `process.stdout.isTTY` |
| `headless` | the complement of `tui` |

`require` omitted or empty means "always load", so migration is opt-in per
package. Sources are unpinned specifiers that must already be installed
(`npm:<name>`, `git:<url>`, or a path); the gate never installs or updates
anything, and it refuses a version-pinned source because Pi's resolver could then
reconcile it.

## How a package is loaded

Pi's own resolver supplies the entrypoints: `getInstalledPath(source, "user")`
must return a path (a pure `existsSync` lookup), then
`resolveExtensionSources([source])` expands the package's `pi.extensions`
manifest — files, directories, globs and multiple entries included — and every
returned path is imported and called with the host API. The settings filter that
keeps the package out of Pi's ambient load is exactly what this gate replaces, so
filtered-out entries are loaded here.

## Properties

- **No install side effects.** Installed-path pre-flight plus the unpinned-source
  rule mean there is no code path from this gate to `npm install`. A test asserts
  the agent directory is byte-for-byte unchanged by a load.
- **No environment or settings mutation.** Only `BB_THREAD_ID` is read, and only
  once, before any await: later env changes need a new runtime or `/reload`.
- **Fail-open with visible warnings.** A missing package, empty manifest, broken
  entrypoint or unknown condition warns once per runtime (UI notification, or
  stderr headlessly) and leaves every sibling loaded. Nothing is swallowed.
- **Exact parity.** For a loaded package the tool, command and hook surface is
  identical to discovering that package's entrypoints directly.
- **Explicit wiring.** One line in `settings.json.extensions` and one filter per
  gated package; both are asserted by tests.

## Limitations

- Gating the extension does **not** hide the package's skills or prompts. That
  axis is static in settings and has no runtime filter, so a gated package's
  skill stays visible in both hosts.
- Project-scope package declarations, `-e <path>` on the command line, and
  manual/bashed launches can bypass this arrangement. This is host routing for the
  user's own environment, not authentication, isolation or a security boundary.
- Gated packages load at the gate's position in `settings.json.extensions`, not at
  their own former position. Keep order-sensitive packages ordered in
  `host-gate.json`.
- Child sessions created by pi-subagents load through their own required-extension
  snapshot, so they do not inherit this gate.
- `index.ts`/`index.js`/`package.json` are deliberately absent here so the gate
  itself can never be discovered ambiently in addition to its settings entry.

## Activation and rollback

Activation: replace the loader path in `settings.json.extensions` with
`extensions/host-gate/loader.ts` and filter each gated package to
`{ "source": "...", "extensions": [] }`, then `/reload` (or restart Pi).

Rollback is the same edit in reverse: give the package its extensions back
(remove the `extensions` filter, or point the loader path back at the previous
gate) and reload. The superseded `pi-subagents-host-gate/` directory was removed
once this gate held its host rule and its tests.

Tested against Pi 1.1.0 with pi-subagents 0.77.0 and pi-interactive-shell 0.17.1
on Node 22.23.2. See [design and validation](docs/design.md).
