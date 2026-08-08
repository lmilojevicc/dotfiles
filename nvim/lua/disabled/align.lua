return {
  "Vonr/align.nvim",
  branch = "v2",
  event = "BufRead",
  -- stylua: ignore
  keys = {
    { mode = "x", "gaa", function() require("align").align_to_string() end, { desc = "Align" } },
  },
}
