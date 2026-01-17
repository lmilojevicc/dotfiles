stow .
chmod +x scripts/*
stow scripts --target ~/.local/bin
stow zsh --target ~
stow git --target ~ && echo "Configure ~/.gitconfig.local"
