return {
  "ibhagwan/fzf-lua",
  cmd = "FzfLua",

  config = function()
    require("fzf-lua").setup({
      "telescope",
      fzf_colors = {
        true,
        ["bg"] = "-1",
        ["bg+"] = "-1",
        ["preview-bg"] = "-1",
        ["gutter"] = "-1",
      },
    })
  end,

  --stylua: ignore
  keys = {
    -- Search
    { "<leader>ff", function() require("fzf-lua").files() end, desc = " Find Files", },
    { "<leader>fg", function() require("fzf-lua").live_grep() end, desc = " Live Grep", },
    { "<leader>fb", function() require("fzf-lua").buffers() end, desc = " Find Buffers", },
    { "<leader>fw", function() require("fzf-lua").grep_cword() end, desc = "  Grep Word", },

    -- LSP
    { "gD", function() require("fzf-lua").lsp_declarations({ jump_to_single_result = true }) end, desc = " Go to Declaration", },
    { "gd", function() require("fzf-lua").lsp_definitions({ jump_to_single_result = true }) end, desc = " Go to Definition", },
    { "gr", function() require("fzf-lua").lsp_references({ jump_to_single_result = true }) end, desc = " Show LSP References", },
    { "gi", function() require("fzf-lua").lsp_implementations({ jump_to_single_result = true }) end, desc = " Show LSP Implementations", },
    { "gy", function() require("fzf-lua").lsp_typedefs() end, desc = " Show LSP type definitions", },
    { "gs", function() require("fzf-lua").lsp_document_symbols() end, desc = " Document Symbols", },

    -- Diganostics
    { "<leader>dw", function() require("fzf-lua").lsp_workspace_diagnostics() end, desc = " Workspace diagnostics", },
    { "<leader>db", function() require("fzf-lua").lsp_document_diagnostics() end, desc = " Buffer diagnostics", },

    -- Help
    { "<leader>fh", function() require("fzf-lua").help_tags() end, desc = "󰘥 Help Tags", },
    { "<leader>fm", function() require("fzf-lua").man_pages() end, desc = "󰘥 Man Pages", },
    { "<leader>fk", function() require("fzf-lua").keymaps({ winopts = { height = 40, preview = { vertical = "right:%55" }, }, }) end, desc = "  Search Keymaps", },

    -- Colorschemes
    { "<leader>cp", function() require("fzf-lua").colorschemes() end, desc = " Colorscheme", },
    { "<leader>cP", function() require("fzf-lua").awesome_colorschemes() end, desc = " Awesome Colorscheme", },
  },
}
