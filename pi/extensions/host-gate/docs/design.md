# host gate — design and validation

## Why a loader instead of a runtime switch

Pi decides which extensions load from settings; `ExtensionAPI` offers no way to
unload or veto a peer extension (verified against Pi 1.1.0
`dist/core/extensions/types.d.ts`: registration, `getActiveTools`/`getAllTools`/
`setActiveTools`, `getCommands`, `events`, hooks — nothing that disables another
extension). Enable/disable is therefore settings plus a reload, and that is what
dotfiles' own `extension-manager` does. A package that must not load in a given
host has to be *kept out of Pi's ambient load* and loaded by something that knows
the host. This gate is that something: one thin extension that owns the
entrypoints of the gated packages.

## Module layout

| File | Role | SDK dependency |
| --- | --- | --- |
| `loader.ts` | Pi entry. Captures host facts, builds Pi's resolver, delegates. | yes (host-provided) |
| `gate.ts` | Core: config → decisions → resolve → import → register; warnings; reporting | type-only |
| `manifest.ts` | Pure `resolveSources`: installed-path pre-flight, per-source failures, dedupe | none |
| `config.ts` | `host-gate.json` snapshot, validation, warnings | none |
| `host.ts` | Host conditions and the AND decision | none |

`loader.ts` is the only module that imports Pi at runtime, so the rest is
unit-testable under bare `node --test` (Pi's package is only resolvable inside a
Pi runtime). The directory intentionally contains no `index.ts`, `index.js` or
`package.json`, so Pi cannot discover the gate ambiently in addition to its
explicit settings entry.

## Resolution safety

`resolveSources` refuses to touch a source that is not already installed:
`PackageManager.getInstalledPath(source, "user")` is a pure `existsSync` lookup,
and a `undefined` result becomes a warning instead of a resolution. That matters
because `resolveExtensionSources` **installs** missing sources when it is not
given an `onMissing` callback, and reconciles a source whose spec carries a
version range (`installedNpmMatchesConfiguredVersion` returns `true` only when no
range is configured). Both paths are closed: uninstalled sources are skipped, and
`config.ts` refuses pinned sources with an explicit warning ("a version-pinned
source can make Pi's resolver install or reconcile; list it unpinned"). This
preserves the property the superseded gate promised: the gate never installs,
updates or reconciles packages. Pi itself still installs and updates *configured*
packages, which is why the gated packages stay declared in settings with only
their extension resource filtered.

## Behaviour contract

- Host facts are captured once, synchronously, before any await; a later env
  change is invisible until a new runtime or `/reload`.
- `require` conditions are ANDed; unknown conditions never load and warn.
- Configuration is data: `packages.<source>.require`. Unknown top-level keys,
  unknown per-entry keys, blank sources, bad `require` values and pinned sources
  each warn and skip only the affected input; valid siblings still load.
- A resolved package's entries are imported in config order then manifest order,
  deduplicated by resolved path. Each factory receives the exact host API object.
- Failures are collected, not thrown: the extension keeps Pi's loader clean and
  reports every warning once per runtime through `ctx.ui.notify` (or `console.error`
  headlessly), at `session_start`, or at the first `before_agent_start` if no
  start event fired. The reporting hook never returns a prompt.
- Because gated factories receive the host API, their hooks are attributed to the
  gate's extension record by Pi's runner — the same attribution Pi applies to any
  extension that registers through an API object.

## Tested surface

Offline, no model or network requests (`node --test tests/*.test.ts`, 26 tests):

- `host.test.ts` — condition matrix (BB/non-BB × TTY/headless, including
  whitespace-only and unfamiliar IDs), AND semantics, unlisted packages.
- `config.test.ts` — ordering, optional `require`, missing/malformed/non-object
  config, invalid entries, unknown keys and conditions, pinned-source refusal,
  fail-open sibling preservation, exact warning counts.
- `manifest.test.ts` — ordering, multi-entry packages, dedupe, uninstalled
  sources, per-source throw, empty manifest, empty input.
- `gate.test.ts` — BB loads nothing and never resolves; ordinary hosts load
  through the exact API; AND matrix; broken entrypoint isolation; missing and
  empty packages; throwing resolver; report-once semantics (UI and headless,
  repeated events); no prompt mutation; host facts frozen at install time.
- `settings.test.ts` — one gate loader path, both gated packages filtered with
  `extensions: []` and no skills/prompts filter, config matches the filtered
  packages, no ambient discovery entrypoint.
- `installed-gate.test.ts` — the real SDK resource loader against a temporary
  agent directory with both packages symlinked: BB registers neither `subagent`
  nor `interactive_shell`; ordinary Pi registers both (including the TypeScript
  `pi-interactive-shell` entrypoint) with **tool, command and hook sets identical
  to direct discovery** of the same entrypoints; the agent directory listing is
  unchanged by loading (no install side effects); a gate entry that settings does
  not configure warns once and is never resolved; a second reload restores
  ordinary routing.

Environment overrides for the fixtures: `PI_GATE_TEST_SDK`,
`PI_GATE_TEST_SUBAGENTS`, `PI_GATE_TEST_INTERACTIVE_SHELL`. Absent fixtures skip
the installed coverage.

## Known limits

- Skills and prompts of a gated package remain enabled in every host: that axis
  is static in settings and Pi exposes no runtime filter (`resources_discover`
  only adds resources).
- Project-scope package declarations, command-line `-e` paths and manual launches
  bypass this gate; it is host routing, not isolation.
- Gated packages load at the gate's settings position, changing their former load
  order; order-sensitive packages must be ordered in `host-gate.json`.
- Child sessions of pi-subagents load through their own required-extension
  snapshot and do not run this gate.
- Verified against Pi 1.1.0 / pi-subagents 0.77.0 / pi-interactive-shell 0.17.1 on
  Node 22.23.2. Pi's package-manager internals (`getInstalledPath` semantics,
  `installedNpmMatchesConfiguredVersion` range behaviour, `pi.extensions`
  expansion) are re-checked by `installed-gate.test.ts`; revalidate after Pi
  upgrades.
