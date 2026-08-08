return {
  "nvim-treesitter/nvim-treesitter-context",
  event = "LspAttach",
  opts = {
    mode = "cursor",
    max_lines = 1,
  },
  keys = {
    { "<leader>tc", "<cmd>TSContextToggle<CR>", desc = "󰨚 Toggle Treesitter Context" },
  },
}
