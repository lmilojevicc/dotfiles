# ⚙️ Dotfiles

Collection of dotfiles to keep my development environment consistent across different machines.

## Setup

```bash
# Clone to home directory
git clone https://github.com/lmilojevicc/dotfiles.git ~/dotfiles
cd ~/dotfiles

# Install all configs
dotty link --all

# Or install specific modules
dotty link scripts zsh git

# Preview changes before linking
dotty link --all --dry-run
```
