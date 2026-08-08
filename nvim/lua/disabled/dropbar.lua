return {
  "Bekaboo/dropbar.nvim",
  event = "BufReadPre",
  opts = {},

  -- stylua: ignore
  keys = {
    { "<leader>;", function() require("dropbar.api").pick() end, desc = " Dropbar pick symbols" },
    { "[;", function() require("dropbar.api").goto_context_start() end, desc = " Dropbar go to start of current context" },
    { "];", function() require("dropbar.api").select_next_context() end, desc = " Dropbar select next context" },
  },
}
