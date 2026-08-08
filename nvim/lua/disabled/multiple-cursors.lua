return {
  "brenton-leighton/multiple-cursors.nvim",
  event = "VeryLazy",
  opts = {},
  --stylua: ignore
  keys = {
    { mode = { "n", "x" }, "<leader>cN", "<Cmd>MultipleCursorsAddMatches<CR>", desc = " Add cursor to all matches" },
    { mode = { "n", "x" }, "<leader>cn", "<Cmd>MultipleCursorsAddJumpNextMatch<CR>", desc = " Add cursor to next match" },
    { mode = { "n", "x" }, "<leader>cj", "<Cmd>MultipleCursorsAddDown<CR>", desc = " Add cursor and move down" },
    { mode = { "n", "x" }, "<leader>ck", "<Cmd>MultipleCursorsAddUp<CR>", desc = " Add cursor and move up" },
  },
}
