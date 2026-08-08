return {
  {
    "tpope/vim-dadbod",
    lazy = true,
  },

  {
    "kristijanhusak/vim-dadbod-ui",
    dependencies = {
      { "tpope/vim-dadbod", lazy = true },
    },
    cmd = { "DBUI", "DBUIToggle", "DBUIAddConnection", "DBUIFindBuffer" },
    init = function()
      vim.g.db_ui_use_nerd_fonts = 1
      vim.g.db_ui_win_position = "right"
      vim.g.db_ui_winwidth = 40

      vim.g.db_ui_drawer_sections = {
        "new_query",
        "saved_queries",
        "schemas",
        "buffers",
      }
    end,

    keys = {
      { "<leader>dbu", "<cmd>DBUIToggle<cr>", desc = " Toggle DBUI" },
      { "<leader>dbf", "<cmd>DBUIFindBuffer<cr>", desc = " Find DBUI Buffer " },
      { "<leader>dba", "<cmd>DBUIAddConnection<cr>", desc = " Add DB Connection" },
    },
  },
}
