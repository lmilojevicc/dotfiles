return {
  "nvim-mini/mini.cursorword",
  event = "VeryLazy",
  version = "*",
  config = function()
    require("mini.cursorword").setup({})
  end,
}
