# Environment Variables
export EDITOR="nvim"
export MANPAGER="nvim +Man!"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export WEZTERM_CONFIG_FILE="$XDG_CONFIG_HOME/wezterm/wezterm.lua"
export BUN_INSTALL="$HOME/.bun"
export TMUX_CONFIG_DIR="$HOME/.config/tmux"
export DENO_INSTALL="$HOME/.deno"
export STARSHIP_CONFIG="$XDG_CONFIG_HOME/starship/starship.toml"
export POSTING_THEME_DIRECTORY="$XDG_CONFIG_HOME/posting/themes"

# PATH
export PATH="$DENO_INSTALL/bin:$PATH"
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export PATH="$(go env GOPATH)/bin:$PATH"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
export PATH="$HOME/.opencode/bin:$PATH"

# FZF Default Options
export FZF_CTRL_T_OPTS="--preview 'bat --color=always {}' \
  --bind 'alt-p:toggle-preview'"
export FZF_ALT_C_OPTS="--preview 'eza -la --color=always {}'"
export FZF_CTRL_R_OPTS="
  --bind 'ctrl-y:execute-silent(echo -n {2..} | pbcopy)+abort' \
  --color header:italic \
  --prompt=\"  \" \
  --header 'Press CTRL-Y to copy command into clipboard'"
export FZF_DEFAULT_COMMAND="fd --type f --hidden --follow"
export FZF_DEFAULT_OPTS=" \
--color=bg+:#11111b,bg:#11111b,spinner:#F5E0DC,hl:#F38BA8 \
--color=fg:#CDD6F4,header:#89B4FA,info:#CBA6F7,pointer:#F5E0DC \
--color=marker:#B4BEFE,fg+:#CDD6F4,prompt:#CBA6F7,hl+:#F38BA8 \
--color=selected-bg:#313244 \
--color=border:#313244,label:#CDD6F4 \
--style full \
--height 60% \
--tmux 80%,70% \
--prompt=\"  \" \
--pointer=\" \" \
--marker=\" \"
--bind 'alt-p:toggle-preview'"

# Custom fzf options for zoxide's 'zi' command
export _ZO_FZF_OPTS=" \
--color=bg+:#11111b,bg:#11111b,spinner:#F5E0DC,hl:#F38BA8 \
--color=fg:#CDD6F4,header:#89B4FA,info:#CBA6F7,pointer:#F5E0DC \
--color=marker:#B4BEFE,fg+:#CDD6F4,prompt:#CBA6F7,hl+:#F38BA8 \
--color=selected-bg:#313244 \
--color=border:#313244,label:#CDD6F4 \
--style full \
--height 60% \
--tmux 80%,70% \
--prompt=\"  \" \
--pointer=\" \" \
--marker=\" \" \
--preview 'eza -lh --icons=auto --color=always {2..}' \
--bind 'alt-p:toggle-preview'"

export LS_COLORS="$(vivid generate catppuccin-mocha)"
export LS_OPTIONS='-F --color=auto'

export FX_LINE_NUMBERS=true
export FX_THEME=3

# Homebrew Setup
if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Custom completions
fpath=(~/.zsh/completions $fpath)

# Completion System
autoload -Uz compinit && compinit

# History Settings
HISTSIZE=10000
SAVEHIST=10000
HISTFILE=~/.zsh_history
SAVEHIST=$HISTSIZE
setopt EXTENDED_HISTORY
setopt INC_APPEND_HISTORY
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
zinit snippet OMZP::brew
zinit snippet OMZP::python
zinit snippet OMZP::node
zinit snippet OMZP::npm
zinit snippet OMZP::golang
zinit snippet OMZP::postgres
zinit snippet OMZP::mongocli
zinit snippet OMZP::docker-compose
zinit snippet OMZP::pip
zinit ice wait lucid as"completion"
zinit snippet OMZP::docker
zinit ice wait lucid as"completion"
zinit snippet OMZP::macos

# Ensure completion system is properly loaded after plugins
zinit cdreplay -q

# fzf-tab Configuration
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*:descriptions' format '[%d]'
zstyle ':completion:*' menu no
zstyle ':fzf-tab:*' use-fzf-default-opts yes
zstyle ':fzf-tab:*' fzf-flags --bind=tab:accept --height=60%
zstyle ':fzf-tab:*' switch-group ',' '.'
zstyle ':fzf-tab:*' prefix ''
zstyle ':fzf-tab:*' continuous-trigger '/'
zstyle ':fzf-tab:complete:*:*' fzf-preview 'bat --color=always --style=numbers --line-range=:500 $realpath 2>/dev/null || eza -la --color=always $realpath'

# Vim Motions Setup
bindkey -v
export KEYTIMEOUT=1 # Reduce mode switch delay

# Open command in editor
autoload -Uz edit-command-line
zle -N edit-command-line
bindkey -M vicmd 'ge' edit-command-line

function tmux-man-split() {
    if [[ -z "$TMUX" ]]; then
        zle -M "Not in tmux session"
        return 1
    fi

    local cmd="${BUFFER%% *}"
    if [[ -z "$cmd" ]]; then
        zle -M "No command in buffer"
        return 1
    fi

    local current_word="${LBUFFER##* }${RBUFFER%% *}"

    local search_pattern=""
    if [[ "$current_word" =~ ^-+ ]]; then
        search_pattern="-p '^\s*${current_word//-/\\-}'"
    fi

    local tmux_cmd="man $search_pattern $cmd 2>/dev/null || $cmd --help 2>/dev/null | nvim - $search_pattern || echo \"No manual entry or --help for $cmd\"; read -k 1 -s -p 'Press any key to close...'"

    tmux split-window -v -l 40% "zsh -c '$tmux_cmd'"
}

zle -N tmux-man-split
bindkey '^X^M' tmux-man-split

# Expands history expressions like !! or !$ on space
bindkey ' ' magic-space

# Aliases and bindkeys
alias lvim='NVIM_APPNAME=nvim-lazy nvim'
alias lvi='NVIM_APPNAME=nvim-lazy nvim'
alias vi="nvim"
alias vim="nvim"

alias c='clear'
alias l='eza -lh  --icons=auto'
alias ll='eza -lha --icons=auto --sort=name --group-directories-first'
alias ltime='eza -lha --icons=auto --sort=time'
alias lsize='eza -lha --icons=auto --sort=size --total-size'
alias ldir='eza -lhD --icons=auto'
alias ltre="eza --tree --level=2 --long --icons --git"

alias brewup='brew update && brew outdated --json | jq -r ".formulae + .casks | .[].name" | xargs -P0 -L1 brew fetch && brew upgrade --greedy && brew cleanup'

alias kps="keepassxc-cli"
alias lg="lazygit"
alias ld="lazydocker"

alias ddgr='ddgr -x -n 5'

# Run zi with Alt-Z
bindkey -s '\ez' 'zi\n'

# Git
bindkey -s '^Xgc' 'git commit -m ""'
bindkey -s '^Xgs' 'git status --short\n'
bindkey -s '^Xgl' 'git log --oneline -n 10\n'

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
    # If already in a virtualenv, do nothing
    if [[ -n "$VIRTUAL_ENV" && ! -f "$VIRTUAL_ENV/bin/activate" ]]; then
        deactivate
    fi

    [[ -n "$VIRTUAL_ENV" ]] && return

    local dir="$PWD"
    while [[ "$dir" != "/" ]]; do
        if [[ -f "$dir/.venv/bin/activate" ]]; then
            source "$dir/.venv/bin/activate"
            return
        fi
        dir="${dir:h}"
    done
}

function auto_ls() {
    if command -v eza &>/dev/null; then
        eza --icons=auto --color=always
    elif command -v lsd &>/dev/null; then
        lsd --color=always
    else
        ls --color=auto
    fi
}

add-zsh-hook chpwd auto_venv
add-zsh-hook chpwd auto_ls

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

# External Tool Integrations

# ghcup environment
[ -f "$HOME/.ghcup/env" ] && . "$HOME/.ghcup/env"

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"

# Generated for envman. Do not edit.
[ -s "$HOME/.config/envman/load.sh" ] && source "$HOME/.config/envman/load.sh"

[[ -f ~/.secrets ]] && source ~/.secrets
