return {
  "folke/persistence.nvim",
  event = "BufReadPre",
  opts = {},
  --stylua: ignore
  keys = {
    { "<leader>wr", function() require("persistence").load() end, desc = "󰦛 Restore session for cwd", },
    { "<leader>wR", function() require("persistence").select() end, desc = "󰦛 Choose session to restore for cwd", },
  },
}
