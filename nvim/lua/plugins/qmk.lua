return {
  "codethread/qmk.nvim",
  ft = { "c", "dts" },
  dependencies = { "nvim-treesitter/nvim-treesitter" },
  config = function()
    local qmk = require("qmk")

    qmk.setup({
      name = "Corne",
      variant = "zmk",
      auto_format_pattern = "*.keymap",
      layout = {
        "x x x x x x _ _ _ _ x _ _ x x x x x x",
        "x x x x x x _ _ _ x x x _ x x x x x x",
        "x x x x x x _ x _ _ x _ _ x x x x x x",
        "_ _ _ x x x _ _ _ _ _ _ _ x x x _ _ _",
      },
      comment_preview = {
        position = "none",
        keymap_overrides = {
          -- Replace long keycodes with shorter descriptions
          ["KC_TRANSPARENT"] = "TRANS",
          ["KC_TRNS"] = "TRANS",
        },
      },
    })
  end,
}
