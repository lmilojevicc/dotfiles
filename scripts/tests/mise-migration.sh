#!/usr/bin/env bash
# Run: bash scripts/tests/mise-migration.sh (Python 3.11+ and zsh; no installs).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PYTHON="$(command -v python3)"
ZSH="$(command -v zsh)"
TEST_HOME="$(mktemp -d "$ROOT/scripts/tests/.mise-migration.XXXXXX")"
trap 'rm -rf "$TEST_HOME"' EXIT

"$PYTHON" - "$ROOT" "$TEST_HOME" <<'PY'
import pathlib
import sys
import tomllib

root, home = map(pathlib.Path, sys.argv[1:])
def config(name):
    return tomllib.loads((root / name).read_text())

mise = config("mise/config.toml")
assert mise["settings"]["go"]["set_gobin"] is False
# Disabling set_gobin alone would leave an inherited version-specific GOBIN.
assert mise["env"]["GOBIN"] == "{{env.HOME}}/go/bin"
assert "go:golang.org/x/tools/gopls" in mise["tools"]
for tool in ("npm:agent-browser", "npm:@devcontainers/cli", "npm:skills"):
    assert mise["tools"][tool] == "latest"
cmake = mise["tools"]["aqua:Kitware/CMake"]
assert cmake["version"] == "latest"
# Kitware ships CMake.app; the postinstall must keep the install CLI-only.
assert "cmake-gui" in cmake["postinstall"]
assert "Qt*.framework" in cmake["postinstall"]
assert mise["tools"]["pypi:oraios/serena"] == {
    "version": "1.7.0", "package_name": "serena-agent"
}
assert "npm:omniroute" not in mise["tools"]

zsh_links = config("dotty.toml")["packages"]["zsh"]["links"]
for name in (".zshrc", ".zprofile"):
    assert {"source": name, "target": f"~/{name}"} in zsh_links
assert "mise activate zsh)" in (root / "zsh/.zshrc").read_text()
assert "BUN_INSTALL" not in (root / "zsh/.zshrc").read_text()
profile = (root / "zsh/.zprofile").read_text()
for binary in ("/opt/homebrew/bin/mise", "/usr/local/bin/mise"):
    assert f"[[ -x {binary} ]]" in profile

upgrade = config("topgrade/topgrade.toml")
assert upgrade["misc"]["only"] == [
    "rustup", "cargo", "tldr", "yazi", "github_cli_extensions", "custom_commands"
]
assert "mise" not in upgrade
commands = upgrade["commands"]
assert commands["Zinit Self-Update"] == "zsh -i -c 'zinit self-update'"
assert commands["Zinit Plugins"] == "zsh -i -c 'setopt nohup; zinit update --parallel 40'"
assert commands["uv cache prune"] == "uv cache prune"
mise_commands = [cmd for cmd in commands.values() if "mise" in cmd]
assert mise_commands == ["mise plugins update && mise upgrade --global --yes --no-prune"]
(home / "upgrade-command").write_text(mise_commands[0])
print("PASS: TOML, durable GOBIN, tool requests, zsh links, global-only Topgrade command")
PY

mkdir -p "$TEST_HOME/bin" "$TEST_HOME/project" "$TEST_HOME/.local/share/mise/shims"
cp "$ROOT/zsh/.zprofile" "$TEST_HOME/.zprofile"
# Skip system login startup files (e.g. macOS path_helper); load the real profile.
printf 'unsetopt GLOBAL_RCS\n' > "$TEST_HOME/.zshenv"
cat > "$TEST_HOME/bin/mise" <<'SH'
#!/bin/sh
printf '%s|%s|%s\n' "$0" "$*" "${LOCAL_LOGIN:-missing}" >> "$HOME/mise-calls"
case "$*" in
  'activate zsh --shims')
    printf '%s\n' 'export PATH="$HOME/.local/share/mise/shims:$PATH"'
    ;;
  'plugins update') exit "${PLUGIN_EXIT:-0}" ;;
  'upgrade --global --yes --no-prune') ;;
  *) exit 99 ;;
esac
SH
cat > "$TEST_HOME/.local/share/mise/shims/node" <<'SH'
#!/bin/sh
printf 'shim-node\n'
SH
chmod +x "$TEST_HOME/bin/mise" "$TEST_HOME/.local/share/mise/shims/node"

login_probe='[[ ! -o interactive && -o login ]] || exit 1
print -r -- "$PATH"
print -r -- "${LOCAL_LOGIN:-missing}"
print -r -- "${mise_bin-unset}"
node'

: > "$TEST_HOME/mise-calls"
output="$(env -i HOME="$TEST_HOME" ZDOTDIR="$TEST_HOME" PATH="$TEST_HOME/bin:/usr/bin:/bin" \
  "$ZSH" -l -c "$login_probe")"
expected="$(printf '%s\n' "$TEST_HOME/.local/share/mise/shims:$TEST_HOME/bin:/usr/bin:/bin" missing unset shim-node)"
[[ "$output" == "$expected" ]]
[[ "$(cat "$TEST_HOME/mise-calls")" == "$TEST_HOME/bin/mise|activate zsh --shims|missing" ]]
printf 'PASS: clean noninteractive login initializes shims without .zprofile.local\n'

mkdir -p "$TEST_HOME/local-bin"
cp "$TEST_HOME/bin/mise" "$TEST_HOME/local-bin/mise"
cat > "$TEST_HOME/.zprofile.local" <<'SH'
export LOCAL_LOGIN=preserved
export PATH="$HOME/local-bin:$PATH"
SH
: > "$TEST_HOME/mise-calls"
output="$(env -i HOME="$TEST_HOME" ZDOTDIR="$TEST_HOME" PATH="$TEST_HOME/bin:/usr/bin:/bin" \
  "$ZSH" -l -c "$login_probe")"
expected="$(printf '%s\n' "$TEST_HOME/.local/share/mise/shims:$TEST_HOME/local-bin:$TEST_HOME/bin:/usr/bin:/bin" preserved unset shim-node)"
[[ "$output" == "$expected" ]]
[[ "$(cat "$TEST_HOME/mise-calls")" == "$TEST_HOME/local-bin/mise|activate zsh --shims|preserved" ]]
printf 'PASS: local exports/PATH precede shim init and command -v mise is preferred\n'

# The custom command must remain global even when launched inside a project.
printf '[tools]\nnode = "1"\n' > "$TEST_HOME/project/mise.toml"
upgrade_command="$(cat "$TEST_HOME/upgrade-command")"
: > "$TEST_HOME/mise-calls"
(cd "$TEST_HOME/project" && env -i HOME="$TEST_HOME" PATH="$TEST_HOME/bin:/usr/bin:/bin" \
  /bin/sh -c "$upgrade_command")
expected="$(printf '%s\n' "$TEST_HOME/bin/mise|plugins update|missing" "$TEST_HOME/bin/mise|upgrade --global --yes --no-prune|missing")"
[[ "$(cat "$TEST_HOME/mise-calls")" == "$expected" ]]
: > "$TEST_HOME/mise-calls"
if (cd "$TEST_HOME/project" && env -i HOME="$TEST_HOME" PATH="$TEST_HOME/bin:/usr/bin:/bin" PLUGIN_EXIT=1 \
  /bin/sh -c "$upgrade_command"); then
  printf 'FAIL: failed plugin update should stop upgrade\n' >&2
  exit 1
fi
[[ "$(cat "$TEST_HOME/mise-calls")" == "$TEST_HOME/bin/mise|plugins update|missing" ]]
printf 'PASS: global-only upgrade from project cwd; failed plugin update stops upgrade\n'
