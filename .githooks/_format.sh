#!/usr/bin/env bash
# Shared formatting helpers for the git hooks and `mise run fmt`.
# Sourced, not executed.

# Fail early with an actionable message instead of a bare "command not found".
dotfiles_require() {
  local tool=$1
  command -v "$tool" >/dev/null 2>&1 && return 0
  echo "pre-commit: $tool not found on PATH." >&2
  echo "  Run 'mise install' in $(git rev-parse --show-toplevel) (versions are pinned in mise.toml)," >&2
  echo "  or bypass this hook with 'git commit --no-verify'." >&2
  return 1
}

# True when the file starts with a bash/sh shebang (zsh is not supported by shfmt).
dotfiles_is_shell() {
  local first
  IFS= read -r first <"$1" 2>/dev/null || return 1
  case "$first" in
  '#!'*'/bash' | '#!'*' bash' | '#!'*'/sh' | '#!'*' sh') return 0 ;;
  esac
  return 1
}

# Format the given paths (relative to the repo root) with the same tools nvim's
# conform uses: oxfmt for JS/TS/JSON/CSS/Markdown/YAML/TOML, stylua for Lua,
# shfmt (2-space via .editorconfig) for shell. Paths with no formatter are left
# alone. Must be called with the repo root as the working directory.
dotfiles_format() {
  local ox=() lua=() sh=() f
  for f in "$@"; do
    [[ -f $f ]] || continue
    case "$f" in
    *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.css | *.md | *.yaml | *.yml | *.toml)
      ox+=("$f")
      ;;
    *.lua) lua+=("$f") ;;
    *.sh) sh+=("$f") ;;
    *)
      # Extensionless executables such as scripts/runner, gated on their shebang.
      dotfiles_is_shell "$f" && sh+=("$f")
      ;;
    esac
  done

  local rc=0
  if ((${#ox[@]})); then
    dotfiles_require oxfmt || return 1
    oxfmt --write -- "${ox[@]}" || rc=1
  fi
  if ((${#lua[@]})); then
    dotfiles_require stylua || return 1
    stylua -- "${lua[@]}" || rc=1
  fi
  if ((${#sh[@]})); then
    dotfiles_require shfmt || return 1
    shfmt --write --indent 2 -- "${sh[@]}" || rc=1
  fi
  return $rc
}
