#!/usr/bin/env bash
# Run on macOS (screenshot-mode uses BSD sed): bash scripts/tests/screenshot-mode.sh
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/screenshot-mode"
TEST_HOME="$(mktemp -d)"
trap 'rm -rf "$TEST_HOME"' EXIT
export HOME="$TEST_HOME"
export PATH="$HOME/bin:$PATH"
mkdir -p "$HOME/bin" "$HOME/dotfiles/"{herdr,ghostty,nvim/lua/plugins}

# Never contact the real Herdr server during tests.
cat > "$HOME/bin/herdr" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$HOME/reloads"
exit "${RELOAD_EXIT:-0}"
EOF
chmod +x "$HOME/bin/herdr"

HERDR_CONF="$HOME/dotfiles/herdr/config.toml"
GHOSTTY_CONF="$HOME/dotfiles/ghostty/config"
NVIM_CONF="$HOME/dotfiles/nvim/lua/plugins/catppuccin.lua"

assert_on() {
  [[ "$(grep -c '^[[:space:]]*pane_borders[[:space:]]*=' "$HERDR_CONF")" == 1 ]]
  grep -q '^[[:space:]]*pane_borders[[:space:]]*=[[:space:]]*"off"$' "$HERDR_CONF"
  grep -q '^[[:space:]]*hide_tab_bar_when_single_tab = true$' "$HERDR_CONF"
  grep -q '^background-opacity = 0.8$' "$GHOSTTY_CONF"
  grep -q 'bg = "NONE"' "$NVIM_CONF"
  grep -q '^  agent_panel_sort = "spaces"$' "$HERDR_CONF"
}

assert_absent() {
  if grep -q "$1" "$2"; then
    printf 'FAIL: unexpected %s in %s\n' "$1" "$2" >&2
    exit 1
  fi
}

assert_off() {
  assert_absent '^[[:space:]]*pane_borders[[:space:]]*=' "$HERDR_CONF"
  assert_absent '^[[:space:]]*hide_tab_bar_when_single_tab[[:space:]]*=' "$HERDR_CONF"
  assert_absent '^background-opacity[[:space:]]*=' "$GHOSTTY_CONF"
  grep -q 'bg = colors.base' "$NVIM_CONF"
  grep -q '^  agent_panel_sort = "spaces"$' "$HERDR_CONF"
}

for borders in absent '"auto"' '"always"' '"off"' true false; do
  printf '[ui]\n  agent_panel_sort = "spaces"\n' > "$HERDR_CONF"
  if [[ "$borders" != absent ]]; then
    printf '\tpane_borders= %s # existing override\n' "$borders" >> "$HERDR_CONF"
  fi
  printf '# Cursor settings\ncursor-style = block\n' > "$GHOSTTY_CONF"
  printf 'a = { fg = colors.blue, bg = colors.base }\n' > "$NVIM_CONF"
  : > "$HOME/reloads"

  bash "$SCRIPT" on >/dev/null
  assert_on
  bash "$SCRIPT" on >/dev/null
  assert_on
  bash "$SCRIPT" >/dev/null
  assert_off
  bash "$SCRIPT" off >/dev/null
  assert_off
  bash "$SCRIPT" >/dev/null
  assert_on
  RELOAD_EXIT=1 bash "$SCRIPT" off >/dev/null
  assert_off
  [[ "$(grep -c '^server reload-config$' "$HOME/reloads")" == 6 ]]
  printf 'PASS: initial pane_borders=%s; explicit/repeated/toggled modes and failed reload\n' "$borders"
done
