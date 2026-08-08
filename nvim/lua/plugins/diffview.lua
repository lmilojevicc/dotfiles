return {
  "sindrets/diffview.nvim",
  dependencies = {
    { "nvim-tree/nvim-web-devicons", lazy = true },
  },
  event = "VeryLazy",

  opts = {
    enhanced_diff_hl = true,
    merge_tool = {
      layout = "diff3_mixed",
      disable_diagnostics = true,
      winbar_info = true,
    },
    view = {
      merge_tool = {
        layout = "diff3_mixed",
        winbar_info = true,
        disable_diagnostics = true,
      },
    },
  },

  keys = {
    { "<leader>gdo", "<cmd>DiffviewOpen<cr>", desc = " Diffview Open" },
    { "<leader>gdc", "<cmd>DiffviewClose<cr>", desc = " Diffview Close" },
    { "<leader>gdh", "<cmd>DiffviewFileHistory %<cr>", desc = " Diffview Current File History" },
    { "<leader>gdH", "<cmd>DiffviewFileHistory<cr>", desc = " Diffview File History" },
  },
}
