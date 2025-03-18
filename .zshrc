# Environment variables
export WEZTERM_CONFIG_FILE="$HOME/.config/wezterm/wezterm.lua"
export PATH="$PATH:/Applications/Docker.app/Contents/Resources/bin/"
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
export MANPAGER="nvim +Man!"
export XDG_CONFIG_HOME="$HOME/.config"
export PATH=$PATH:$(go env GOPATH)/bin

# Catppuccin Mocha theme for fzf
export FZF_DEFAULT_OPTS=" \
--color=bg+:#1a1a1a,bg:#000000,spinner:#f5e0dc,hl:#f38ba8 \
--color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
--color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8"

# iTerm2 Integration
test -e "${HOME}/.iterm2_shell_integration.zsh" && source "${HOME}/.iterm2_shell_integration.zsh"

# Homebrew setup
if [[ -f "/opt/homebrew/bin/brew" ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# Initialize completion system
autoload -Uz compinit && compinit

# History settings
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

# Zinit installation
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"
if [ ! -d "$ZINIT_HOME" ]; then
   mkdir -p "$(dirname $ZINIT_HOME)"
   git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
fi

source "${ZINIT_HOME}/zinit.zsh"

# Load plugins without waiting
zinit light zsh-users/zsh-syntax-highlighting
zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions
zinit light Aloxaf/fzf-tab

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

setopt globdots


# fzf-tab styling
zstyle ':fzf-tab:*' fzf-pad 4 
zstyle ':fzf-tab:*' prefix ''
zstyle ':fzf-tab:*' continuous-trigger 'tab'
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*:descriptions' format '[%d]'
zstyle ':completion:*' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*' menu no
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'eza -1 --color=always $realpath'
# Combined preview that handles both files and directories
zstyle ':fzf-tab:complete:*:*' fzf-preview 'bat --color=always --style=numbers --line-range=:500 $realpath 2>/dev/null || eza -la --color=always $realpath'
zstyle ':fzf-tab:*' fzf-flags \
  --color=bg+:#45475a,bg:#11111b,spinner:#f5e0dc,hl:#f38ba8 \
  --color=fg:#cdd6f4,header:#f38ba8,info:#cba6f7,pointer:#f5e0dc \
  --color=marker:#f5e0dc,fg+:#cdd6f4,prompt:#cba6f7,hl+:#f38ba8

# Aliases
alias c='clear'
alias l='eza -lh  --icons=auto'
alias ls='eza -1   --icons=auto'
alias ll='eza -lha --icons=auto --sort=name --group-directories-first'
alias ld='eza -lhD --icons=auto'
alias cd="z"
alias cat="bat"
alias lg="lazygit"
alias brewup='brew update && brew upgrade && brew upgrade --cask --greedy && brew cleanup'

# Shell integrations
eval "$(fzf --zsh)"
eval "$(starship init zsh)"
eval "$(zoxide init zsh)"
eval "$(/opt/homebrew/bin/brew shellenv)"

# Ensure completion system is properly loaded
zinit cdreplay -q

# Vim motions setup
ZVM_VI_ESCAPE_BINDKEY='^['
ZVM_KEYTIMEOUT=0
bindkey -v
bindkey '^b' history-search-backward
bindkey '^n' history-search-forward
zinit ice depth=1
zinit light jeffreytse/zsh-vi-mode

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

# Search files and cd into dir
function ffd() {
    local file
    file=$(rg --files --hidden --follow --glob '!.git/*' | \
           fzf --preview 'bat --style=numbers --color=always {}' \
               --preview-window right:50%:wrap \
               --color='fg:#cdd6f4,fg+:#cdd6f4,bg:#000000,bg+:#1a1a1a,hl:#f38ba8,hl+:#f38ba8' \
               --color='info:#cba6f7,border:#89b4fa,prompt:#f5e0dc,pointer:#f5c2e7,marker:#a6e3a1,spinner:#f5e0dc,header:#89b4fa'
               --border=rounded \
               --prompt="󰍉 " \
               --pointer="󰁔" \
               --marker="󰄲" \
               --header='Find Files')
    if [[ -n "$file" ]]; then
        cd "$(dirname "$file")"
    fi
}

# Search file match and open in nvim
function ffv() {
    local file
    file=$(rg --files --hidden --follow --glob '!.git/*' | \
           fzf --preview 'bat --style=numbers --color=always {}' \
               --preview-window right:50%:wrap \
               --color='fg:#cdd6f4,fg+:#cdd6f4,bg:#000000,bg+:#1a1a1a,hl:#f38ba8,hl+:#f38ba8' \
               --color='info:#cba6f7,border:#89b4fa,prompt:#f5e0dc,pointer:#f5c2e7,marker:#a6e3a1,spinner:#f5e0dc,header:#89b4fa'
               --border=rounded \
               --prompt="󰍉 " \
               --pointer="󰁔" \
               --marker="󰄲" \
               --header='Find Files')
    if [[ -n "$file" ]]; then
        nvim "$file"
    fi
}
function ffdv() {

# Search files, cd into dir, and open in nvim
    local file
    file=$(rg --files --hidden --follow --glob '!.git/*' | \
           fzf --preview 'bat --style=numbers --color=always {}' \
               --preview-window right:50%:wrap \
               --color='fg:#cdd6f4,fg+:#cdd6f4,bg:#000000,bg+:#1a1a1a,hl:#f38ba8,hl+:#f38ba8' \
               --color='info:#cba6f7,border:#89b4fa,prompt:#f5e0dc,pointer:#f5c2e7,marker:#a6e3a1,spinner:#f5e0dc,header:#89b4fa'
               --border=rounded \
               --prompt="󰍉 " \
               --pointer="󰁔" \
               --marker="󰄲" \
               --header='Find Files')
    if [[ -n "$file" ]]; then
        local dir=$(dirname "$file")
        local filename=$(basename "$file")
        cd "$dir"
        nvim "$filename"
    fi
}


# Search text and cd into dir
function rgd() {
    local selection
    selection=$(rg --color=always --line-number --no-heading --smart-case -w . | \
                fzf --ansi \
                    --delimiter : \
                    --preview 'bat --style=numbers --color=always {1} --highlight-line {2}' \
                    --preview-window right:50%:wrap \
                    --color='fg:#cdd6f4,fg+:#cdd6f4,bg:#000000,bg+:#1a1a1a,hl:#f38ba8,hl+:#f38ba8' \
                    --color='info:#cba6f7,border:#89b4fa,prompt:#f5e0dc,pointer:#f5c2e7,marker:#a6e3a1,spinner:#f5e0dc,header:#89b4fa'
                    --border=rounded \
                    --prompt="󰍉 " \
                    --pointer="󰁔" \
                    --marker="󰄲" \
                    --header='Grep Preview')
    if [[ -n "$selection" ]]; then
        local file=$(echo "$selection" | cut -d: -f1)
        cd "$(dirname "$file")"
    fi
}

# Search text match and open in nvim
function rgv() {
    local selection
    selection=$(rg --color=always --line-number --no-heading --smart-case -w . | \
                fzf --ansi \
                    --delimiter : \
                    --preview 'bat --style=numbers --color=always {1} --highlight-line {2}' \
                    --preview-window right:50%:wrap \
                    --color='fg:#cdd6f4,fg+:#cdd6f4,bg:#000000,bg+:#1a1a1a,hl:#f38ba8,hl+:#f38ba8' \
                    --color='info:#cba6f7,border:#89b4fa,prompt:#f5e0dc,pointer:#f5c2e7,marker:#a6e3a1,spinner:#f5e0dc,header:#89b4fa'
                    --border=rounded \
                    --prompt="󰍉 " \
                    --pointer="󰁔" \
                    --marker="󰄲" \
                    --header='Grep Preview')
    if [[ -n "$selection" ]]; then
        # Extract only the file path and line number, ignoring the matched text
        local file=$(echo "$selection" | cut -d ':' -f 1)
        local line=$(echo "$selection" | cut -d ':' -f 2)
        
        # Remove any ANSI color codes from the file path
        file=$(echo "$file" | sed 's/\x1b\[[0-9;]*m//g')
        
        if [[ -f "$file" ]]; then
            nvim "$file" "+${line}"
        fi
    fi
}

# Search text, cd into dir, and open in nvim
function rgdv() {
    local selection
    selection=$(rg --color=always --line-number --no-heading --smart-case -w . | \
                fzf --ansi \
                    --delimiter : \
                    --preview 'bat --style=numbers --color=always {1} --highlight-line {2}' \
                    --preview-window right:50%:wrap \
                    --color='fg:#cdd6f4,fg+:#cdd6f4,bg:#000000,bg+:#1a1a1a,hl:#f38ba8,hl+:#f38ba8' \
                    --color='info:#cba6f7,border:#89b4fa,prompt:#f5e0dc,pointer:#f5c2e7,marker:#a6e3a1,spinner:#f5e0dc,header:#89b4fa'
                    --border=rounded \
                    --prompt="󰍉 " \
                    --pointer="󰁔" \
                    --marker="󰄲" \
                    --header='Grep Preview')
    if [[ -n "$selection" ]]; then
        # Extract only the file path and line number, ignoring the matched text
        local file=$(echo "$selection" | cut -d ':' -f 1)
        local line=$(echo "$selection" | cut -d ':' -f 2)
        
        # Remove any ANSI color codes from the file path
        file=$(echo "$file" | sed 's/\x1b\[[0-9;]*m//g')
        
        if [[ -f "$file" ]]; then
            cd "$(dirname "$file")"
            nvim "${file##*/}" "+${line}"
        fi
    fi
}

function yy() {
    local tmp="$(mktemp -t "yazi-cwd.XXXXXX")" cwd
    yazi "$@" --cwd-file="$tmp"
    if cwd="$(command cat -- "$tmp")" && [ -n "$cwd" ] && [ "$cwd" != "$PWD" ]; then
        builtin cd -- "$cwd"
    fi
    rm -f -- "$tmp"
}


PATH=~/.console-ninja/.bin:$PATH

# Load Angular CLI autocompletion.
source <(ng completion script)
