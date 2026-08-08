return {
  "fredrikaverpil/godoc.nvim",
  version = "*",
  dependencies = {
    { "folke/snacks.nvim" },
  },
  build = "go install github.com/lotusirous/gostdsym/stdsym@latest",
  cmd = { "GoDoc" },
  ft = "godoc",
  opts = {},
}
