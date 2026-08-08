return {
  "akinsho/bufferline.nvim",
  version = "*",
  event = "VeryLazy",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  opts = function(_, opts)
    opts.options = {
      -- stylua: ignore
      close_command = function(n) Snacks.bufdelete(n) end,
      -- stylua: ignore
      middle_mouse_command = function(n) Snacks.bufdelete(n) end,

      highlights = require("catppuccin.special.bufferline").get_theme(),

      always_show_bufferline = true,

      diagnostics = "nvim_lsp",
      diagnostics_indicator = function(count, level, diagnostics_dict, context)
        local icons = {
          error = "",
          warn = "",
          warning = "",
          info = "",
          hint = "",
        }

        local parts = {}
        for diag_type, num in pairs(diagnostics_dict) do
          local icon = icons[diag_type] or ""
          table.insert(parts, string.format("%s %d", icon, num))
        end

        if #parts == 0 then
          return ""
        end
        return " " .. table.concat(parts, " ")
      end,

      offsets = {
        { filetype = "snacks_layout_box" },
      },
    }
  end,

  keys = {
    { "<leader>bp", "<Cmd>BufferLineTogglePin<CR>", desc = "Bufferline Toggle Pin" },
    { "<leader>bP", "<Cmd>BufferLineGroupClose ungrouped<CR>", desc = "Buffferline Delete Non-Pinned Buffers" },
    { "<leader>bL", "<Cmd>BufferLineCloseRight<CR>", desc = "Bufferline Delete Buffers to the Right" },
    { "<leader>bH", "<Cmd>BufferLineCloseLeft<CR>", desc = "Bufferline Delete Buffers to the Left" },
    { "[b", "<cmd>BufferLineCyclePrev<cr>", desc = "Bufferline Prev Buffer" },
    { "]b", "<cmd>BufferLineCycleNext<cr>", desc = "Bufferline Next Buffer" },
    { "[B", "<cmd>BufferLineMovePrev<cr>", desc = "Bufferline Move buffer prev" },
    { "]B", "<cmd>BufferLineMoveNext<cr>", desc = "Bufferline Move buffer next" },
    { "<leader>bl", "<cmd>BufferLinePick<cr>", desc = "Bufferline Pick Buffer" },
  },
}
