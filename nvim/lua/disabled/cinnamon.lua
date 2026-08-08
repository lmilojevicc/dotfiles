return {
  "declancm/cinnamon.nvim",
  version = "*",
  opts = {
    keymaps = {
      basic = true,
      extra = true,
    },

    options = {
      mode = "cursor",
      max_delta = {
        time = 500,
      },
    },
  },
  keys = {
    { "<C-d>", "<cmd>lua require('cinnamon').scroll('<C-d>zz')<CR>", desc = " Smooth scroll down" },
    { "<C-u>", "<cmd>lua require('cinnamon').scroll('<C-u>zz')<CR>", desc = " Smooth scroll up" },
    { "<C-f>", "<cmd>lua require('cinnamon').scroll('<C-f>zz')<CR>", desc = " Smooth scroll page down" },
    { "<C-b>", "<cmd>lua require('cinnamon').scroll('<C-b>zz')<CR>", desc = " Smooth scroll page up" },
    { "gg", "<cmd>lua require('cinnamon').scroll('gg')<CR>", desc = " Smooth scroll to top" },
    { "G", "<cmd>lua require('cinnamon').scroll('G')<CR>", desc = " Smooth scroll to bottom" },
  },
}
