return {
  "folke/todo-comments.nvim",
  event = "BufReadPost",
  dependencies = { "nvim-lua/plenary.nvim" },
  opts = {},
  --stylua: ignore
  keys = {
    { "]t", function() require("todo-comments").jump_next() end, desc = " Next Todo Comment" },
    { "[t", function() require("todo-comments").jump_prev() end, desc = " Previous Todo Comment" },
    { "<leader>tt", "<cmd>Trouble todo toggle<cr>", desc = " Todo (Trouble)" }
  },
}
