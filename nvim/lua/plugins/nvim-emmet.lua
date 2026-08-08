return {
  "olrtg/nvim-emmet",
  ft = { "html", "css", "javascript", "typescriptreact" },

  --stylua: ignore
  keys = {
    { mode = { "n", "v" }, "<leader>em", function() require("nvim-emmet").wrap_with_abbreviation() end, desc = " Emmet wrap with abbreviation", },
  },
}
