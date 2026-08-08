return {
  "numToStr/Comment.nvim",
  event = { "InsertEnter", "BufReadPost" },
  opts = {},
  --stylua: ignore
  keys = {
    { mode = { "n" }, "<leader>/", "<Plug>(comment_toggle_linewise_current)", desc = "󰨚 Toggle comment for current line" },
    { mode = { "v" }, "<leader>/", "<Plug>(comment_toggle_linewise_visual)", desc = "󰨚 Toggle comment for selected lines" },
  },
}
