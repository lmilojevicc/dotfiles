return {
  "chrisgrieser/nvim-origami",
  event = "VeryLazy",
  opts = {
    useLspFoldsWithTreesitterFallback = {
      foldmethodIfNeitherIsAvailable = function(bufnr)
        return vim.bo[bufnr].filetype == "bigfile" and "manual" or "indent"
      end,
    },
    foldKeymaps = {
      setup = false,
    },
  },
}
