# Environment Variables
export EDITOR="nvim"
export MANPAGER="nvim +Man!"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export WEZTERM_CONFIG_FILE="$XDG_CONFIG_HOME/wezterm/wezterm.lua"
export BUN_INSTALL="$HOME/.bun"
export TMUX_CONFIG_DIR="$HOME/.config/tmux"

# PATH
export PATH="$BUN_INSTALL/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export PATH="$(go env GOPATH)/bin:$PATH"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"

# FZF Default Options
export FZF_CTRL_T_OPTS="--preview 'bat --color=always {}' \
  --bind 'alt-p:toggle-preview'"
export FZF_ALT_C_OPTS="--preview 'eza -la --color=always {}'"
export FZF_CTRL_R_OPTS="
  --bind 'ctrl-y:execute-silent(echo -n {2..} | pbcopy)+abort'
  --color header:italic
  --header 'Press CTRL-Y to copy command into clipboard'"
export FZF_DEFAULT_COMMAND="fd --type f"
export FZF_DEFAULT_OPTS=" \
--color=bg+:#11111b,bg:#11111b,spinner:#F5E0DC,hl:#F38BA8 \
--color=fg:#CDD6F4,header:#89B4FA,info:#CBA6F7,pointer:#F5E0DC \
--color=marker:#B4BEFE,fg+:#CDD6F4,prompt:#CBA6F7,hl+:#F38BA8 \
--color=selected-bg:#313244 \
--color=border:#313244,label:#CDD6F4 \
--style full \
--height 60% \
--tmux 80%,70% \
--prompt=\" \" \
--pointer=\"󰁔 \" \
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
--prompt=\" \" \
--pointer=\"󰁔 \" \
--marker=\" \" \
--preview 'eza -lh --icons=auto --color=always {2..}' \
--bind 'alt-p:toggle-preview'"

# Homebrew Setup
if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Docker CLI completions
fpath=(~/.docker/completions $fpath)

# Completion System
autoload -Uz compinit && compinit

# History Settings
HISTSIZE=5000
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
zinit light jeffreytse/zsh-vi-mode

# Oh-My-Zsh snippets
zinit snippet OMZL::git.zsh
zinit snippet OMZP::git
zinit snippet OMZP::sudo
zinit snippet OMZP::command-not-found
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
zinit snippet OMZP::rust
zinit ice wait lucid as"completion"
zinit snippet OMZP::macos

# Ensure completion system is properly loaded after plugins
zinit cdreplay -q

# fzf-tab Configuration
zstyle ':fzf-tab:*' fzf-pad 4
zstyle ':fzf-tab:*' fzf-flags --bind=tab:accept
zstyle ':fzf-tab:*' fzf-opts '--min-height 35% --border --layout=reverse'
zstyle ':fzf-tab:*' prefix ''
zstyle ':fzf-tab:*' continuous-trigger 'tab'
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*:descriptions' format '[%d]'
zstyle ':completion:*' menu no
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'eza -1 --color=always $realpath'
zstyle ':fzf-tab:complete:*:*' fzf-preview 'bat --color=always --style=numbers --line-range=:500 $realpath 2>/dev/null || eza -la --color=always $realpath'
zstyle ':fzf-tab:*' use-fzf-default-opts yes

# Aliases
alias lvim='NVIM_APPNAME=nvim-lazy nvim'
alias vi="nvim"
alias vim="nvim"

alias c='clear'
alias l='eza -lh  --icons=auto'
alias ls='eza -1   --icons=auto'
alias ll='eza -lha --icons=auto --sort=name --group-directories-first'
alias ld='eza -lhD --icons=auto'
alias lt='eza -T --icons=auto'

alias cd="z"
alias cat="bat"
alias lg="lazygit"
alias brewup='brew update && brew upgrade && brew upgrade --cask --greedy && brew cleanup'

# Vim Motions Setup
ZVM_VI_ESCAPE_BINDKEY='^['
ZVM_KEYTIMEOUT=0

# Run zi with Alt-Z
bindkey -s '\ez' 'zi\n'

alias tsm='tmux-session-manager'
bindkey -s '\et' 'tmux-session-manager\n'

alias ssm='sesh-fzf'
bindkey -s '\es' 'ssm\n'

# Accept suggestions with 'C-Space'
bindkey '^ ' autosuggest-accept

# Shell Integrations
eval "$(fzf --zsh)"
eval "$(starship init zsh)"
eval "$(zoxide init zsh)"

# Auto-start tmux
if command -v tmux &>/dev/null && [ -z "$TMUX" ]; then
    tmux attach || tmux new-session
fi

# Custom Functions

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

# External Tool Integrations

# Angular CLI autocompletion
source <(ng completion script)

# ghcup environment
[ -f "$HOME/.ghcup/env" ] && . "$HOME/.ghcup/env"

# bun completions
[ -s "$HOME/.bun/_bun" ] && source "$HOME/.bun/_bun"
