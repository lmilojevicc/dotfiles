return {
  "windwp/nvim-ts-autotag",
  event = { "BufReadPost" },
  config = function()
    require("nvim-ts-autotag").setup()
  end,
}
