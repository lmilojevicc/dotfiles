# Environment Variables
alias lvim='NVIM_APPNAME=nvim-lazy nvim'  # Alias for lazy nvim

export WEZTERM_CONFIG_FILE="$HOME/.config/wezterm/wezterm.lua"
export MANPAGER="nvim +Man!"
export XDG_CONFIG_HOME="$HOME/.config"
export EDITOR="nvim"

# PATH 
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin"
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export PATH="$PATH:$(go env GOPATH)/bin"
export PATH="$HOME/.local/bin:$PATH"

# FZF Default Options
export FZF_CTRL_T_OPTS="--preview 'bat --color=always {}' \
  --bind 'ctrl-/:change-preview-window(down|hidden|)'"
export FZF_ALT_C_OPTS="--preview 'eza -la --color=always {}'"
export FZF_CTRL_R_OPTS="--preview 'echo {}' --preview-window up:3:hidden:wrap --bind 'ctrl-/:toggle-preview'"
export FZF_DEFAULT_COMMAND="fd --type f"
export FZF_DEFAULT_OPTS=" \
--color=bg+:#1e1e2e,bg:#11111b,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8 \
--preview-window '~3' \
--height 40% \
--border=rounded \
--border \
--prompt=\"󰍉 \" \
--pointer=\"󰁔\" \
--marker=\"󰄲\"
--bind 'ctrl-/:change-preview-window(50%|hidden|)'"

# Homebrew Setup
if [[ -f "/opt/homebrew/bin/brew" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Completion System
autoload -Uz compinit && compinit  

# Docker CLI completions
fpath=(/Users/milo/.docker/completions $fpath)

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

# Plugins 
zinit ice wait lucid
zinit light zsh-users/zsh-syntax-highlighting
zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions
zinit light Aloxaf/fzf-tab
zinit light thirteen37/fzf-alias

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
zinit snippet OMZP::tmux
zinit snippet OMZP::vscode
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

# fzf-tab Styling
zstyle ':fzf-tab:*' fzf-pad 4 
zstyle ':fzf-tab:*' prefix ''
zstyle ':fzf-tab:*' continuous-trigger 'tab'
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*:descriptions' format '[%d]'
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*' menu no
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'eza -1 --color=always $realpath'
zstyle ':fzf-tab:complete:*:*' fzf-preview 'bat --color=always --style=numbers --line-range=:500 $realpath 2>/dev/null || eza -la --color=always $realpath'

# Aliases
alias c='clear'
alias l='eza -lh  --icons=auto'
alias ls='eza -1   --icons=auto'
alias ll='eza -lha --icons=auto --sort=name --group-directories-first'
alias ld='eza -lhD --icons=auto'

alias fe='$EDITOR $(fzf)'
alias fkill='ps -ef | fzf | awk "{print \$2}" | xargs kill -9'
alias frg='rg --color=always --line-number --no-heading --smart-case "" | fzf --ansi --delimiter : --preview "bat --color=always {1} --highlight-line {2}" | cut -d ":" -f1,2 | xargs -r $EDITOR +$(cut -d ":" -f2) $(cut -d ":" -f1)'

alias cd="z"
alias cat="bat"
alias lg="lazygit"
alias brewup='brew update && brew upgrade && brew upgrade --cask --greedy && brew cleanup'

alias tsm='tmux_session_manager'
bindkey -s '\et' 'tmux_session_manager\n'

# Shell Integrations
eval "$(fzf --zsh)"
eval "$(starship init zsh)"
eval "$(zoxide init zsh)"

# Auto-start tmux
if command -v tmux &> /dev/null && [ -z "$TMUX" ]; then
    tmux attach || tmux new-session
fi

# Vim Motions Setup
ZVM_VI_ESCAPE_BINDKEY='^['
ZVM_KEYTIMEOUT=0
bindkey -v
zinit ice depth=1
zinit light jeffreytse/zsh-vi-mode

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
        for ((i=1; i<=levels; i++)); do
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
[ -f "/Users/milo/.ghcup/env" ] && . "/Users/milo/.ghcup/env"


# bun completions
[ -s "/Users/milo/.bun/_bun" ] && source "/Users/milo/.bun/_bun"

# bun
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
