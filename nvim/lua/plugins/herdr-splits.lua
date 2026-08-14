return {
  "lmilojevicc/herdr-splits.nvim",
  cond = vim.env.HERDR_ENV == "1",
  event = "VeryLazy",
  config = function()
    require("herdr-splits").setup({
      -- Defaults shown. All fields optional.
      default_amount = 0.03, -- Herdr resize ratio
      neovim_amount = 3,     -- Neovim resize cells
      at_edge = "wrap",      -- 'wrap' | 'stop' | 'split' | function
      ignored_buftypes = { "nofile", "quickfix", "prompt" },
      move_cursor_same_row = false,
      herdr_bin = nil,        -- auto-detected from HERDR_BIN_PATH
      auto_sync_herdr = true, -- opt-in: sync Herdr-side scripts on update
      nav_keys = { left = "<C-h>", down = "<C-j>", up = "<C-k>", right = "<C-l>" },
      resize_keys = { left = "<C-Left>", down = "<C-Down>", up = "<C-Up>", right = "<C-Right>" },
    })
  end,

  -- stylua: ignore
  keys = {
    { "<C-h>",     function() require("herdr-splits").move_cursor_left() end,  mode = { "n", "t" }, desc = "Navigate left" },
    { "<C-j>",     function() require("herdr-splits").move_cursor_down() end,  mode = { "n", "t" }, desc = "Navigate down" },
    { "<C-k>",     function() require("herdr-splits").move_cursor_up() end,    mode = { "n", "t" }, desc = "Navigate up" },
    { "<C-l>",     function() require("herdr-splits").move_cursor_right() end, mode = { "n", "t" }, desc = "Navigate right" },
    { "<C-Left>",  function() require("herdr-splits").resize_left() end,       mode = { "n", "t" }, desc = "Resize left" },
    { "<C-Down>",  function() require("herdr-splits").resize_down() end,       mode = { "n", "t" }, desc = "Resize down" },
    { "<C-Up>",    function() require("herdr-splits").resize_up() end,         mode = { "n", "t" }, desc = "Resize up" },
    { "<C-Right>", function() require("herdr-splits").resize_right() end,      mode = { "n", "t" }, desc = "Resize right" },
  },
}
