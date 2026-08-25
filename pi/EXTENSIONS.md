# Pi extensions

## Project-specific installed packages

- `npm:pi-poster`
- `npm:pi-annotate`

## Locally managed packages

| Package | Purpose | Primary activation | Test (from package directory) |
| --- | --- | --- | --- |
| [codex-enhanced](extensions/codex-enhanced/README.md) | Codex quota, banked resets, and Fast processing | `/codex-enhanced` | `npm test` |
| [command-code](extensions/command-code/README.md) | Command Code provider, model catalogue, and account usage | Select a `command-code/...` model; `/command-code-usage` | `npm test` |
| [terminal-focus-cursor](extensions/terminal-focus-cursor/README.md) | Hide the editor cursor when its terminal pane is unfocused | TUI under Herdr (`HERDR_ENV=1`) or tmux (`TMUX`) | `npm test` |
| [model-favorites](extensions/model-favorites/README.md) | Favorite and order models in the selector | `Ctrl+F` on a highlighted model | `npm test` |
| [prefix-keybinds](extensions/prefix-keybinds/README.md) | Configurable prefix-key command layer | Configured prefix then mapped key; `/prefix-keybinds` | `npm test` |
| [reader-mode](extensions/reader-mode/README.md) | Experimental private-internals centered session column | `/reader` | `npm test` |
| [session-auto-rename](extensions/session-auto-rename/README.md) | Name a new unnamed session from its first prompt | Automatic on the first prompt; `/session-auto-rename` selects the model | `npm test` |
| [skill-search](extensions/skill-search/README.md) | Search and temporarily read skills from user-approved public GitHub repositories | `search_skills`, `read_skill`, `/skill-repos` | `npm test` |

Pi discovers these packages through the `~/.pi/agent/extensions` directory symlink. After package or entrypoint changes, a full Pi restart is recommended.

## Other extension-directory content

- `herdr-agent-state.ts` and `seshagy-agent-state.ts` are generated third-party files; do not edit them.
- `pi-tool-display/` and `subagent/` are configuration-only directories, not locally managed packages.
- Keep Awake is outside this migration; its deletion remains a separate user working-tree change.
