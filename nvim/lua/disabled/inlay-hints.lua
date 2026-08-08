return {
  "MysticalDevil/inlay-hints.nvim",
  event = "LspAttach",
  dependencies = { "neovim/nvim-lspconfig" },
  config = function()
    require("inlay-hints").setup({
      autocmd = { enable = false },
      commands = { enable = true },
    })
  end,
  keys = {
    { "<leader>gl", "<cmd>InlayHintsToggle<CR>", desc = "󰨚 Toggle Inlay Hints" },
  },
}
