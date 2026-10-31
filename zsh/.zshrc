# Environment Variables
export EDITOR="nvim"
export MANPAGER="nvim +Man!"

export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

# Machines other than the home one label themselves in the starship prompt
# (starship reads [hostname] detect_env_vars = STARSHIP_REMOTE_HOST).
[[ "$(hostname -s)" != "lychee" ]] && export STARSHIP_REMOTE_HOST=1

export WEZTERM_CONFIG_FILE="$XDG_CONFIG_HOME/wezterm/wezterm.lua"
export TMUX_CONFIG_DIR="$HOME/.config/tmux"
export STARSHIP_CONFIG="$XDG_CONFIG_HOME/starship/starship.toml"
export POSTING_THEME_DIRECTORY="$XDG_CONFIG_HOME/posting/themes"
export PI_LENS_CONFIG_PATH="$XDG_CONFIG_HOME/pi/pi-lens.json"
export PI_LENS_HOME="$XDG_DATA_HOME/pi-lens"
export PI_WEB_ACCESS_CACHE_ROOT="$XDG_CACHE_HOME/pi"
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true

# Must precede zinit's bun/uv snippets, which run mise shims at source time.
export MISE_ENV="${MISE_ENV:-macos}"

# PATH
export PATH="$HOME/go/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

# FZF Default Options
export FZF_CTRL_T_OPTS=" \
    --preview 'bat --color=always {}' \
    --bind 'alt-p:toggle-preview'"
export FZF_ALT_C_OPTS=" \
    --preview 'eza -la --color=always {}'"
export FZF_CTRL_R_OPTS=" \
    --bind 'ctrl-y:execute-silent(echo -n {2..} | pbcopy)+abort' \
    --color header:italic \
    --prompt=\"  \" \
    --header 'Press CTRL-Y to copy command into clipboard'"
export FZF_DEFAULT_COMMAND="fd --type f --hidden --follow"
export FZF_DEFAULT_OPTS=" \
    --color=spinner:#F5E0DC,hl:#F38BA8 \
    --color=fg:#CDD6F4,header:#F5C2E7,info:#94E2D5,pointer:#F38BA8 \
    --color=marker:#B4BEFE,fg+:#CDD6F4,prompt:#94E2D5,hl+:#F38BA8 \
    --color=selected-bg:#1e1e2e,current-bg:#1e1e2e\
    --color=border:#313244,label:#CDD6F4 \
    --reverse \
    --multi \
    --style full \
    --height 60% \
    --prompt=\"> \" \
    --marker=\"> \" \
    --bind 'alt-p:toggle-preview'"

# Custom fzf options for zoxide's 'zi' command
export _ZO_FZF_OPTS=" \
    --color=spinner:#F5E0DC,hl:#F38BA8 \
    --color=fg:#CDD6F4,header:#F5C2E7,info:#94E2D5,pointer:#F38BA8 \
    --color=marker:#B4BEFE,fg+:#CDD6F4,prompt:#94E2D5,hl+:#F38BA8 \
    --color=selected-bg:#1e1e2e,current-bg:#1e1e2e\
    --color=border:#313244,label:#CDD6F4 \
    --reverse \
    --style full \
    --height 60% \
    --prompt=\"> \" \
    --marker=\"> \" \
    --preview 'eza -lh --icons=auto --color=always {2..}' \
    --bind 'alt-p:toggle-preview'"

if command -v vivid &>/dev/null; then
    export LS_COLORS="$(vivid generate catppuccin-mocha)"
fi

# Homebrew Setup
if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    fpath=("$HOMEBREW_PREFIX/share/zsh/site-functions" $fpath)
fi

# Restart Rift after upgrades replace its Homebrew executable.
brew() {
    if [[ "$1" != "upgrade" ]]; then
        command brew "$@"
        return $?
    fi

    local rift_bin="${HOMEBREW_PREFIX:-/opt/homebrew}/bin/rift"
    local before="" after="" result
    [[ -x "$rift_bin" ]] && before=$(command readlink "$rift_bin" 2>/dev/null)

    command brew "$@"
    result=$?

    if [[ -n "$before" && -x "$rift_bin" ]]; then
        after=$(command readlink "$rift_bin" 2>/dev/null)
        if [[ -n "$after" && "$before" != "$after" ]]; then
            print "Rift upgraded; restarting..."
            "$rift_bin" service restart || print -u2 "Warning: Rift restart failed."
        fi
    fi

    return "$result"
}

# Custom completions
fpath=("$HOME/.zsh/completions" $fpath)

# Completion System
# Prune stale zinit symlinks when plugins remove completion files upstream.
for zinit_completion_dir in "$HOME/.cache/zinit/completions" "$XDG_DATA_HOME/zinit/completions"; do
    for completion in "$zinit_completion_dir"/_*(N); do
        [[ -L "$completion" && ! -e "$completion" ]] && command rm -f -- "$completion"
    done
done

autoload -Uz compinit && compinit

# History Settings
HISTSIZE=10000
HISTFILE=~/.zsh_history
SAVEHIST=$HISTSIZE
setopt EXTENDED_HISTORY
setopt HIST_EXPIRE_DUPS_FIRST
setopt SHARE_HISTORY
setopt HIST_IGNORE_SPACE
setopt HIST_IGNORE_ALL_DUPS
setopt HIST_SAVE_NO_DUPS
setopt HIST_FIND_NO_DUPS
setopt HIST_REDUCE_BLANKS

setopt globdots

# Zinit Installation & Plugins
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"
if [ ! -d "$ZINIT_HOME" ]; then
    mkdir -p "$(dirname $ZINIT_HOME)"
    git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
fi
source "${ZINIT_HOME}/zinit.zsh"

# Unalias 'zi' to avoid conflicts with zoxide zi command
unalias zi 2>/dev/null || true

# Plugins
zinit ice wait lucid
zinit light zsh-users/zsh-syntax-highlighting
zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions
zinit light Aloxaf/fzf-tab
zinit light thirteen37/fzf-alias

# Oh-My-Zsh snippets
zinit snippet OMZP::git
zinit snippet OMZP::golang
zinit snippet OMZP::rust
zinit snippet OMZP::npm
zinit snippet OMZP::bun
zinit snippet OMZP::uv
zinit snippet OMZP::pip
zinit snippet OMZP::aws
zinit snippet OMZP::kubectl

# Ensure completion system is properly loaded after plugins
zinit cdreplay -q

# fzf-tab Configuration
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*:descriptions' format '[%d]'
zstyle ':completion:*' menu no
zstyle ':fzf-tab:*' use-fzf-default-opts yes
zstyle ':fzf-tab:*' fzf-flags --height=60% --bind=tab:accept
zstyle ':fzf-tab:*' prefix ''
zstyle ':fzf-tab:*' fzf-bindings \
    'alt-m:toggle+down' \
    'alt-M:toggle+up'
zstyle ':fzf-tab:complete:*:*' fzf-preview 'bat --color=always --style=numbers --line-range=:500 $realpath 2>/dev/null || eza -la --color=always $realpath'

# Vim Motions Setup
bindkey -v
export KEYTIMEOUT=1 # Reduce mode switch delay

# Open command in editor
autoload -Uz edit-command-line
zle -N edit-command-line
bindkey '^X^E' edit-command-line
bindkey -M vicmd '^X^E' edit-command-line

# Expands history expressions like !! or !$ on space
bindkey ' ' magic-space

# Aliases and bindkeys
alias vi="nvim"
alias vim="nvim"

alias c='clear'
alias l='eza -lh  --icons=auto'
alias ll='eza -lha --icons=auto --sort=name --group-directories-first'
alias ltime='eza -lha --icons=auto --sort=time'
alias lsize='eza -lha --icons=auto --sort=size --total-size'
alias ldir='eza -lhD --icons=auto'
alias ltre="eza --tree --level=2 --long --icons --git"
alias cdt='cd "$(mktemp -d)"'

alias ct='wt switch'

alias kps="keepassxc-cli"
alias lg="lazygit"
alias ld="lazydocker"

alias gdoc="stdsym | fzf | xargs go doc "

alias ddgr='ddgr -x -n 5'

alias oc='opencode --yolo'
alias cc='claude --dangerously-skip-permissions'
alias agy='agy --dangerously-skip-permissions'

alias cask-clean='brew list --cask | fzf | xargs brew uninstall --zap'
alias cli-clean='brew leaves --installed-on-request | fzf | xargs brew uninstall --zap'

# Git
bindkey -s '^Xgc' 'git commit -m ""'
bindkey -s '^Xgs' 'git status --short\n'
bindkey -s '^Xgl' 'git log --oneline -n 10\n'

# fzf git worktree switcher (Alt+W)
fzf-git-worktree-widget() {
    local selected_path
    selected_path=$(
        git worktree list 2>/dev/null | fzf \
            --height 40% --reverse \
            --header="Select Git Worktree" \
            --preview="git -C {1} status -s && echo '' && git -C {1} log --oneline -n 5" \
            --preview-window="right:33%" | awk '{print $1}'
    )

    if [[ -n "$selected_path" ]]; then
        cd "$selected_path"
    fi
    zle reset-prompt
}

zle -N fzf-git-worktree-widget
bindkey '^[w' fzf-git-worktree-widget # Alt+W

# cd to root of git repo
function cdr() {
    local root_dir
    root_dir=$(git rev-parse --show-toplevel 2>/dev/null)
    if [[ $? -eq 0 ]]; then
        cd "$root_dir"
    else
        echo "Not in a git repository"
        return 1
    fi
}

# cd backwards @num
function b() {
    if [[ -z "$1" ]]; then
        cd ..
        return
    fi
    if [[ "$1" =~ ^[0-9]+$ ]]; then
        local levels=$1
        local command=""
        for ((i = 1; i <= levels; i++)); do
            command="../$command"
        done
        cd $command
    else
        echo "Please provide a valid number"
        return 1
    fi
}

autoload -Uz add-zsh-hook
function auto_venv() {
    local dir="$PWD"
    local venv_dir=""

    while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/.venv/bin/activate" ]]; then
            venv_dir="$dir/.venv"
            break
        fi
        dir="${dir:h}"
    done

    if [[ -n "$VIRTUAL_ENV" && "$VIRTUAL_ENV" != "$venv_dir" ]]; then
        (($+functions[deactivate])) && deactivate
    fi

    if [[ -n "$venv_dir" && "$VIRTUAL_ENV" != "$venv_dir" ]]; then
        source "$venv_dir/bin/activate"
    fi
}

add-zsh-hook chpwd auto_venv

# Expand shortened/redirecting URLs to their final destination
# usage: unshorten <url> [url...]
function unshorten() {
    if (( $# == 0 )); then
        print -u2 "usage: unshorten <url> [url...]"
        return 2
    fi

    local c_url="" c_arrow="" c_dim="" c_reset=""
    if [[ -t 1 ]]; then
        c_url=$'\033[36m'
        c_arrow=$'\033[32m'
        c_dim=$'\033[2m'
        c_reset=$'\033[0m'
    fi

    local pretty=0
    (( $# > 1 )) && pretty=1

    local url final i=0 rc=0
    for url in "$@"; do
        (( i++ ))
        [[ "$url" == *://* ]] || url="https://$url"

        if ! final=$(curl -sL -o /dev/null --max-time 30 -w '%{url_effective}' "$url" 2>/dev/null) || [[ -z "$final" ]]; then
            print -u2 "unshorten: failed to resolve $url"
            (( pretty && i < $# )) && print
            rc=1
            continue
        fi

        if (( pretty )); then
            printf '%s%d.%s %s%s%s\n   %s→%s %s\n' \
                "$c_dim" "$i" "$c_reset" "$c_url" "$url" "$c_reset" \
                "$c_arrow" "$c_reset" "$final"
            [[ "${final%/}" == "${url%/}" ]] &&
                print -u2 "${c_dim}   no redirect followed – target may need JS/meta-refresh handling${c_reset}"
            (( i < $# )) && print
        else
            print -r -- "$final"
            [[ "${final%/}" == "${url%/}" ]] &&
                print -u2 "${c_dim}unshorten: no redirect followed – target may need JS/meta-refresh handling${c_reset}"
        fi
    done

    return $rc
}

# Shell Integrations
if command -v fzf &>/dev/null; then
    eval "$(fzf --zsh)"
else
    echo "Warning: fzf not found." >&2
fi

if command -v zoxide &>/dev/null; then
    eval "$(zoxide init zsh)"
else
    echo "Warning: zoxide not found." >&2
fi

if command -v starship &>/dev/null; then
    eval "$(starship init zsh)"
else
    echo "Warning: starship not found. Using default prompt." >&2
fi

if command -v mise &>/dev/null; then
    eval "$(mise activate zsh)"
fi

# External Tool Integrations

if command -v wt >/dev/null 2>&1; then eval "$(command wt config shell init zsh)"; fi
