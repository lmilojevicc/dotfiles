-- Leader keys
vim.g.mapleader = " " -- Primary leader key
vim.g.maplocalleader = "\\" -- Local leader key

-- Basic display
vim.opt.number = true -- Show absolute line numbers
vim.opt.relativenumber = true -- Show relative line numbers
vim.opt.cursorline = true -- Highlight the line under the cursor
vim.opt.signcolumn = "yes" -- Always reserve space for signs (e.g., LSP, Git)
vim.opt.background = "dark" -- Prefer dark backgrounds

-- Wrapping & scrolling
vim.opt.wrap = false -- Disable line wrapping
vim.opt.linebreak = true -- Wrap at word boundaries when wrapping
vim.opt.scrolloff = 999 -- Keep cursor vertically centered
vim.opt.sidescrolloff = 20 -- Horizontal padding when scrolling

-- Indentation & tabs
vim.opt.expandtab = true -- Use spaces instead of tabs
vim.opt.tabstop = 2 -- Number of spaces per Tab
vim.opt.shiftwidth = 2 -- Spaces to use for autoindent
vim.opt.softtabstop = 2 -- Spaces per Tab while editing
vim.opt.autoindent = true -- Copy indent from current line
vim.opt.smartindent = true -- C-style smart indenting
vim.opt.shiftround = true -- Round indent to multiple of shiftwidth
vim.opt.breakindent = true -- Preserve indent in wrapped lines
vim.g.editorconfig = true -- Honor .editorconfig files

-- Search behavior
vim.opt.ignorecase = true -- Case-insensitive search…
vim.opt.smartcase = true -- …unless uppercase used
vim.opt.incsearch = true -- Show search matches as you type
vim.opt.hlsearch = true -- Persist search highlights

-- Visual enhancements
vim.opt.termguicolors = true -- Enable true-color support
vim.opt.showmatch = true -- Briefly jump to matching bracket
vim.opt.matchpairs:append("<:>") -- Treat `<` and `>` as a matching pair
vim.opt.cmdheight = 1 -- Height of command-line area
vim.opt.showmode = false -- Don’t show “-- INSERT --” etc.
vim.opt.completeopt = "menu,menuone,noselect" -- Better completion UI
vim.opt.wildmenu = true -- Enhanced command-line completion
vim.opt.wildmode = "longest:full,full"
vim.opt.pumheight = 10 -- Max items in popup-menu
vim.opt.pumblend = 0 -- Popup transparency (0–100)
vim.opt.winblend = 0 -- Floating window transparency
if vim.fn.has("nvim-0.10") == 1 then
  vim.opt.smoothscroll = true
  vim.opt.cmdheight = 0
end

-- File handling & backups
vim.opt.backup = false -- Don’t keep backup files
vim.opt.writebackup = false -- Don’t backup before overwriting
vim.opt.swapfile = false -- Disable swap files
vim.opt.undofile = true -- Enable persistent undo
vim.opt.undolevels = 1000 -- Keep up to 1000 undo branches
vim.opt.undodir = vim.fn.expand("~/.local/share/nvim/undodir")
vim.opt.updatetime = 200 -- Faster CursorHold, LSP updates
vim.opt.autoread = true -- Auto-reload changed files
vim.opt.autowrite = true -- Auto-save before commands
vim.opt.fileencoding = "utf-8" -- File encoding
vim.opt.ttyfast = true -- Faster terminal redraws

-- Performance & timing
vim.opt.timeoutlen = 300 -- Time to wait for mapped sequence
vim.opt.ttimeoutlen = 0 -- Time to wait for key code sequence

-- Behavior & editing
vim.opt.hidden = true -- Allow background buffers
vim.opt.backspace = "indent,eol,start" -- More powerful backspace
vim.opt.errorbells = false -- Disable error bells
vim.opt.autochdir = false -- Don’t change CWD on buffer open
vim.opt.path:append("**") -- Search in subdirectories
vim.opt.mouse = "a" -- Enable mouse in all modes
vim.opt.clipboard = "unnamedplus" -- Use system clipboard
vim.opt.modifiable = true -- Enable buffer modifications
vim.opt.confirm = true -- Raise confirm dialog for actions that would fail

-- Folding
vim.opt.foldmethod = "expr"
vim.opt.foldtext = ""
vim.opt.foldlevel = 99 -- Don’t fold by default
vim.opt.fillchars = {
  foldopen = "",
  foldclose = "",
  fold = " ",
  foldsep = " ",
  diff = " ",
  eob = " ",
}

-- Window splitting
vim.opt.splitbelow = true -- Horizontal splits below
vim.opt.splitright = true -- Vertical splits to the right

-- NetRW
vim.g.netrw_liststyle = 3 -- Tree-style file browser
