## Linking

- `dotty.toml` is the link map: one `[packages.<name>]` per directory, each link `source` (relative to the package) → `target`.
- Most targets are symlinks into this repo, so **editing a linked file edits the live config**, and tools that write their own config (Pi, lazygit, …) write straight into the repo. Check `git status` before assuming a diff is yours.
- When you add, move or remove a tracked file, update `dotty.toml` and run `dotty link <package>`; `dotty status <package>` shows broken or missing links.
- Never track secrets or machine state: auth tokens, caches, sessions. Link those per machine instead.
- System services (for example `bb.service`) live in the NixOS config at `~/nixos`, not here.

## Layout

| Path                                                 | Notes                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `zsh/`, `starship/`, `tmux/`, `ghostty/`, `wezterm/` | Shell and terminal                                                                                 |
| `nvim/`                                              | Lua config (lazy.nvim); format with StyLua (`nvim/.stylua.toml`); `lazy-lock.json` is tool-managed |
| `mise/config.toml`                                   | Runtimes and global CLI tools                                                                      |
| `scripts/`                                           | Small CLIs linked into `~/.local/bin`; tests in `scripts/tests/`                                   |
| `pi/`                                                | Pi coding agent (see below)                                                                        |
| `opencode/`                                          | OpenCode agents and its own `AGENTS.md`                                                            |
| `aerospace/`, `rift/`, `omniwm/`, `neru/`            | macOS window management                                                                            |

## Pi

- `pi/settings.json` → `~/.pi/agent/settings.json`: the plain Pi config with every package and local extension.
- `pi/bb/settings.json` → `~/.pi/agent-bb/settings.json`: the config BB runs (`PI_CODING_AGENT_DIR=~/.pi/agent-bb` on `bb.service`). It lists only the packages BB needs, and local extensions by path (`~/.pi/agent/extensions/<name>`); anything not listed does not load in BB.
- Keep both files as ordinary Pi settings: plain package strings, no filter objects, no generated entries. Install a BB package with `PI_CODING_AGENT_DIR=~/.pi/agent-bb pi install <source>`.
- `~/.pi/agent-bb/auth.json` and `models.json` are machine-local symlinks to `~/.pi/agent`; never add them to the repo.
- `pi/extensions/` holds local extensions, one directory per extension (see `pi/EXTENSIONS.md`). Most have a `package.json`; run tests from the extension directory with `npm test`. Tests must use a temporary agent dir and must not assert the contents of user-editable files (settings, prompts, config JSON).
- `pi/prompts/` holds prompt templates, one `.md` file per `/command` (`state-machines.md` → `/state-machines`). It is linked into both `~/.pi/agent/prompts` and `~/.pi/agent-bb/prompts`, so new commands load in plain Pi and in BB after `/reload`.
- Pi docs and types ship with the managed install: `~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/{docs,dist}`. Read them instead of guessing the API; Pi cannot unload an extension it loaded from settings.

## Testing

- Pi extensions: `npm --prefix pi/extensions/<name> test`.
- Scripts: `bash scripts/tests/<name>.sh` (`screenshot-mode` needs macOS BSD `sed`).
- Neovim: `nvim --headless -u NONE -l nvim/tests/<name>.lua` (each file's header has the exact command).
- Report failures as they are; do not weaken tests to make them pass.

## Commits

- Conventional Commits with a scope: `feat(pi): …`, `fix(nvim): …`, `chore(mise): …`. One logical change per commit; explain why in the body when it is not obvious.
- Commit or push only when asked. Do not delete files or retire extensions without asking first, even when they look unused.
