# Machine-local login exports must be present before mise initializes shims.
[[ -f "$HOME/.zprofile.local" ]] && source "$HOME/.zprofile.local"

# Must precede shim activation: shims resolve config via MISE_ENV.
export MISE_ENV="${MISE_ENV:-macos}"

# Login shells (including noninteractive ones) need runtime/tool shims on PATH.
if mise_bin=$(command -v mise); then
    :
elif [[ -x /opt/homebrew/bin/mise ]]; then
    mise_bin=/opt/homebrew/bin/mise
elif [[ -x /usr/local/bin/mise ]]; then
    mise_bin=/usr/local/bin/mise
else
    mise_bin=""
fi

if [[ -n "$mise_bin" ]]; then
    eval "$("$mise_bin" activate zsh --shims)"
fi
unset mise_bin
