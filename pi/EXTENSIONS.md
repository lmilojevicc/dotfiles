# Pi extensions

## Project-specific installed packages

- `npm:pi-poster`
- `npm:pi-annotate`

## Locally managed packages

| Package | Purpose | Primary activation | In BB | Test (from package directory) |
| --- | --- | --- | --- | --- |
| [agent-policy](extensions/agent-policy/README.md) | Explicitly configured Markdown policy and full skill bodies as one owned `agent_policy` prompt section; `common`/`child`/`main`/`mainBb`/`agents.<native name>` layers, missing or invalid sources warn and skip instead of falling back | Automatic on every run; edit `config.json`, then `/reload` | yes | `npm test` |
| [bash-jobs](extensions/bash-jobs/README.md) | Pi's `bash`, except that a command still running after 30 s continues as a background job, with `jobs`/`wait %N`/`kill %N` and a message when it exits | Replaces `bash` (Pi and BB); `/jobs` | yes | `npm test` |
| [broadcast-reload](extensions/broadcast-reload/README.md) | Safely reload all active `pi` sessions on the machine from one command, deferring busy sessions and never injecting into working panes | `/broadcast-reload` | — | `npm test` |
| [codex-enhanced](extensions/codex-enhanced/README.md) | Current-account Codex subscription quota, banked resets, Fast processing, and optional OpenAI Responses server compaction | `/codex-enhanced` | — | `npm test` |
| [context](extensions/context/README.md) | Estimated context-window usage breakdown, with per-category previews | `/context` (TUI only) | — | `npm test` |
| [extension-manager](extensions/extension-manager/README.md) | Enable or disable extensions in the running agent dir's settings without deleting or uninstalling them | `/extensions-manager` | — | `npm test` |
| [herdr-pane-namesmith](extensions/herdr-pane-namesmith/docs/usage.md) | Keeps the current Pi pane's Herdr label equal to its Pi session name, following `/name` and `pi.setSessionName()` | Automatic in TUI under Herdr (`HERDR_ENV=1`, pane id and socket) | — | `npm test` |
| [message-jump](extensions/message-jump/docs/usage.md) | Searchable picker of the active branch's real user messages that scrolls the existing fullscreen transcript | `/jump` in interactive fullscreen | — | `npm test` |
| [model-blacklist](extensions/model-blacklist/README.md) | Hide configured model IDs on configured providers from in-session model surfaces | Automatic on `session_start`; `/model-blacklist` reapplies | yes | `npm test` |
| [model-instructions](extensions/model-instructions/README.md) | JSON-configured instructions for the active model, as one owned `model_instructions` prompt section | Automatic; edit `instructions.json` beside the extension | yes | `npm test` |
| [model-picker](extensions/model-picker/README.md) | Browse and favorite models; switch the session and save the global startup default | `/model-picker`; configured prefix then `m` | — | `npm test` |
| [opencode-free](extensions/opencode-free/README.md) | OpenCode Zen free-tier provider: the client fingerprint the free lane requires, plus a self-refreshing free-model catalogue | Select an `opencode-free/...` model | yes | `npm test` |
| [prefix-keybinds](extensions/prefix-keybinds/README.md) | Configurable prefix-key command layer | Configured prefix then mapped key; `/prefix-keybinds` | — | `npm test` |
| [session-auto-rename](extensions/session-auto-rename/README.md) | Name a genuinely new session from its first prompt | Automatic on the first prompt; `/session-auto-rename` selects the model | — | `npm test` |
| [session-to-pane](extensions/session-to-pane/README.md) | Open independent session copies in tmux or Herdr while leaving the source pane and session unchanged | `/fork-to-pane`, `/tree-to-pane`, `/clone-to-pane` | — | `npm test` |
| [tasks](extensions/tasks/README.md) | Session-branch-native task tracking with atomic batches, management menus, and a read-only board | `todo`; `/tasks`, `/todos`, or `/tasks-board`; `Ctrl+Shift+T` | — | `npm test` |
| [terminal-focus-cursor](extensions/terminal-focus-cursor/README.md) | Hide Pi's editor cursor while its terminal pane is unfocused | TUI under Herdr (`HERDR_ENV=1`) or tmux (`TMUX`) | — | `npm test` |
| [usage](extensions/usage/README.md) | Per-provider quota as used percentages in one tabbed panel, plus a `usage` footer status | `/usage` (interactive TUI only) | — | `npm test` |

Pi discovers these packages through the `~/.pi/agent/extensions` directory symlink. BB runs Pi with its own agent dir, `~/.pi/agent-bb` (`PI_CODING_AGENT_DIR` on `bb.service`): `bb/settings.json` lists only the packages and local extensions BB needs, by path — `agent-policy`, `bash-jobs`, `model-blacklist`, `model-instructions` and `opencode-free` among the rows above — and `dotty.toml` links it plus the shared keybindings, model blacklist and themes. `auth.json` and `models.json` there are machine-local symlinks to `~/.pi/agent`. Install BB packages with `PI_CODING_AGENT_DIR=~/.pi/agent-bb pi install <source>`. After package or entrypoint changes, a full Pi restart is recommended. Replacing the removed model-favorites extension requires a full restart to remove its old in-process patches; model-picker leaves native `/model` unchanged and reuses legacy favorites only in its own picker (writes only on an explicit favorite toggle).

## Other extension-directory content

- `startup-header.ts` is a single-file extension that draws the animated startup header (logo, Pi version, cwd) in TUI sessions; `NO_COLOR` or `PI_HEADER_ANIMATE=0` renders it as a still frame.
- `herdr-agent-state.ts` and `seshagy-agent-state.ts` are generated third-party files; do not edit them.
- `pi-tool-display/` and `subagent/` are configuration-only directories, not locally managed packages.
