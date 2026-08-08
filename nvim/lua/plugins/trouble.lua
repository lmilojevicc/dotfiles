return {
  "folke/trouble.nvim",
  event = { "LspAttach" },
  dependencies = { "nvim-tree/nvim-web-devicons", "folke/todo-comments.nvim" },
  opts = { focus = true },
  cmd = "Trouble",

  keys = {
    { "<leader>td", "<cmd>Trouble diagnostics toggle<cr>", desc = " Diagnostics (Trouble)" },
    { "<leader>tb", "<cmd>Trouble diagnostics toggle filter.buf=0<cr>", desc = " Buffer Diagnostics (Trouble)" },
  },
}
