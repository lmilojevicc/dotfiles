return {
  "rachartier/tiny-inline-diagnostic.nvim",
  event = "VeryLazy",
  priority = 1000,
  config = function()
    require("tiny-inline-diagnostic").setup({
      options = { use_icons_from_diagnostic = true },
      signs = {
        left = "",
        right = "",
        diag = "●",
        arrow = "   ",
        up_arrow = "    ",
        vertical = " │",
        vertical_end = " └",
      },
      blend = {
        factor = 0.0,
      },
    })
    vim.diagnostic.config({ virtual_text = false }) -- Only if needed in your configuration, if you already have native LSP diagnostics
  end,
}
