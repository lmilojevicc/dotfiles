return {
  "stevearc/aerial.nvim",
  event = { "BufReadPre" },
  dependencies = {
    "nvim-treesitter/nvim-treesitter",
    "nvim-tree/nvim-web-devicons",
  },
  opts = {
    backends = { "lsp", "treesitter", "markdown", "asciidoc", "man" },
    show_guides = true,

    layout = {
      default_direction = "prefer_right",
      min_width = 40,
      max_width = { 80, 0.5 },
      win_opts = {
        winblend = 10,
        winhl = "Normal:Normal,FloatBorder:FloatBorder",
      },
    },

    nav = {
      border = "rounded",
      max_height = 0.6,
      min_height = 0.6,
      preview = true,
      win_opts = {
        winblend = 5,
      },
    },

    close_automatic_events = { "unfocus", "switch_buffer", "unsupported" },
    filter_kind = {
      "Array",
      "Class",
      "Constant",
      "Constructor",
      "Enum",
      "EnumMember",
      "Event",
      "Field",
      "File",
      "Function",
      "Interface",
      "Key",
      "Method",
      "Module",
      "Namespace",
      "Object",
      "Package",
      "Property",
      "Struct",
      "Variable",
    },
  },

  --stylua: ignore
  keys = {
    { "<leader>fss", function() require("aerial").snacks_picker() end, desc = "󰆧 Find Symbols (Aerial Floating Snacks picker)", },
    { "<leader>fsr", function() require("aerial").snacks_picker({ layout = "right" }) end, desc = "󰆧 Find Symbols (Aerial Sidebar Snacks picker)", },
  },
}
