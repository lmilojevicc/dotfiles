return {
  "saghen/blink.pairs",
  version = "*",
  build = function()
    require("blink.pairs").build():pwait(60000)
  end,
  event = "InsertEnter",
  dependencies = "saghen/blink.download",
  ---@module 'blink.pairs'
  ---@type blink.pairs.Config
  opts = {
    mappings = {
      enabled = true,
    },
    highlights = {
      enabled = true,
      groups = {
        "BlinkPairsOrange",
        "BlinkPairsPurple",
        "BlinkPairsBlue",
      },
    },
  },
}
