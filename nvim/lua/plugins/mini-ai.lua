return {
  "nvim-mini/mini.ai",
  event = { "InsertEnter", "BufReadPost" },
  version = "*",
  config = function()
    require("mini.ai").setup()
  end,
}
