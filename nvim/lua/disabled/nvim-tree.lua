return {
  "nvim-tree/nvim-tree.lua",
  dependencies = {
    "nvim-tree/nvim-web-devicons",
    "catppuccin/nvim",
  },
  event = "VeryLazy",
  config = function()
    local nvimtree = require("nvim-tree")
    local api = require("nvim-tree.api")

    local function on_attach_mapping(bufnr)
      local function opts(desc)
        return { desc = "nvim-tree: " .. desc, buffer = bufnr, noremap = true, silent = true, nowait = true }
      end

      api.config.mappings.default_on_attach(bufnr)

      vim.keymap.set("n", "<leader>h", api.node.open.horizontal, opts("Open: Horizontal Split"))
      vim.keymap.set("n", "<leader>v", api.node.open.vertical, opts("Open: Vertical Split"))
    end

    local catppuccin = require("catppuccin.palettes").get_palette("mocha")

    vim.api.nvim_set_hl(0, "NvimTreeGitDirty", { fg = catppuccin.red })
    vim.api.nvim_set_hl(0, "NvimTreeGitStaged", { fg = catppuccin.green })
    vim.api.nvim_set_hl(0, "NvimTreeGitNew", { fg = catppuccin.blue })
    vim.api.nvim_set_hl(0, "NvimTreeGitDeleted", { fg = catppuccin.red })
    vim.api.nvim_set_hl(0, "NvimTreeGitIgnored", { fg = catppuccin.overlay1 })

    vim.g.loaded_netrw = 1
    vim.g.loaded_netrwPlugin = 1

    nvimtree.setup({
      view = {
        width = 40,
        relativenumber = true,
      },

      renderer = {
        highlight_git = true,
        indent_markers = {
          enable = true,
        },
        icons = {
          show = {
            file = true,
            folder = true,
            folder_arrow = true,
            git = true,
          },
        },
      },

      actions = {
        open_file = {
          window_picker = {
            enable = false,
          },
        },
      },
      filters = {},
      git = {
        ignore = false,
      },

      on_attach = on_attach_mapping,
    })

    -- Auto-close nvim-tree when quitting Neovim
    vim.api.nvim_create_autocmd("QuitPre", {
      callback = function()
        vim.cmd("NvimTreeClose")
      end,
    })
  end,
  keys = {
    { "<leader>ee", "<cmd>NvimTreeToggle<CR>", noremap = true, silent = true, desc = "󰨚 Toggle NvimTree" },
    { "<leader>ex", "<cmd>NvimTreeClose<CR>", desc = " Close NvimTree" },
    { "<leader>ef", "<cmd>NvimTreeFindFile<CR>", desc = " Find current file in tree" },
    { "<C-N>", "<cmd>NvimTreeToggle<CR>", desc = "󰨚 Toggle NvimTree" },
  },
}
