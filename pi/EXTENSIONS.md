# Pi extensions

## Project-specific installed packages

- `npm:pi-poster`
- `npm:pi-annotate`

## Locally managed packages

| Package | Purpose | Primary activation | Test (from package directory) |
| --- | --- | --- | --- |
| [codex-enhanced](extensions/codex-enhanced/README.md) | Codex quota, banked resets, and Fast processing | `/codex-enhanced` | `npm test` |
| [context](extensions/context/README.md) | Context-window usage breakdown and previews | `/context` | `npm test` |
| [command-code](extensions/command-code/README.md) | Command Code provider, model catalogue, and account usage | Select a `command-code/...` model; `/command-code-usage` | `npm test` |
| [extension-manager](extensions/extension-manager/README.md) | Enable or disable global extensions without deleting or uninstalling them | `/extensions-manager` | `npm test` |
| [terminal-focus-cursor](extensions/terminal-focus-cursor/README.md) | Hide the editor cursor when its terminal pane is unfocused | TUI under Herdr (`HERDR_ENV=1`) or tmux (`TMUX`) | `npm test` |
| [tasks](extensions/tasks/README.md) | Session-branch-native task tracking with atomic batches, management menus, and a read-only board | `todo`; `/tasks`, `/todos`, or `/tasks-board`; `Ctrl+Shift+T` | `npm test` |
| [model-instructions](extensions/model-instructions/README.md) | JSON-configured instructions for the active model | Automatic; edit `instructions.json` beside the extension | `npm test` |
| [model-picker](extensions/model-picker/README.md) | Browse/favorite models; switch session and save global default | `/model-picker`; configured prefix then `m` | `npm test` |
| [model-blacklist](extensions/model-blacklist/README.md) | Hide configured model IDs on configured providers from in-session model surfaces | Automatic on `session_start`; `/model-blacklist` reapplies | `npm test` |
| [prefix-keybinds](extensions/prefix-keybinds/README.md) | Configurable prefix-key command layer | Configured prefix then mapped key; `/prefix-keybinds` | `npm test` |
| [processes](extensions/processes/README.md) | Session-owned processes, retained logs, and active/failure status | `process`; `/processes` | `npm test` |
| [reader-mode](extensions/reader-mode/README.md) | Experimental private-internals centered session column | `/reader` | `npm test` |
| [session-auto-rename](extensions/session-auto-rename/README.md) | Name a new unnamed session from its first prompt | Automatic on the first prompt; `/session-auto-rename` selects the model | `npm test` |
| [usage](extensions/usage/README.md) | Per-provider quota as used percentages in tabs, plus a `usage` footer status | `/usage` | `npm test` |

Pi discovers these packages through the `~/.pi/agent/extensions` directory symlink. After package or entrypoint changes, a full Pi restart is recommended. Replacing the removed model-favorites extension requires a full restart to remove its old in-process patches; model-picker leaves native `/model` unchanged and reuses legacy favorites only in its own picker (writes only on an explicit favorite toggle).

The local processes directory replaces `npm:@aliou/pi-processes`; do not configure both or add a duplicate path registration. It substantially adapts pinned upstream 0.12.0 backend/renderers/skill while retaining `/processes` and the versioned read-only status hook. The extension's `resources_discover` hook advertises `pi-processes` without a separate skill registration; remove same-name skill collisions. Stop old package-owned processes before replacement and restart. Session changes/shutdown attempt to stop owned processes and remove logs; no persistence or guaranteed descendant cleanup. `/processes` uses j/k navigation and confirmed x stop (explicit force only at stop-timeout); k never forces. See its [README](extensions/processes/README.md) for status opt-out/subscriber example, log/watch limits and provenance notices.

## Other extension-directory content

- `herdr-agent-state.ts` and `seshagy-agent-state.ts` are generated third-party files; do not edit them.
- `pi-tool-display/` and `subagent/` are configuration-only directories, not locally managed packages.
- Keep Awake is outside this migration; its deletion remains a separate user working-tree change.
