return {
  "mrjones2014/smart-splits.nvim",
  dependencies = { "pogyomo/submode.nvim" },
  cond = vim.env.HERDR_ENV ~= "1",
  event = "VeryLazy",
  config = function()
    require("smart-splits").setup({
      disable_multiplexer_nav_when_zoomed = false,
      cursor_follows_swapped_bufs = true,
      ignored_filetypes = { "NvimTree", "snacks_layout_box" },
    })

    local map = vim.keymap.set
    map({ "n", "t" }, "<C-h>", require("smart-splits").move_cursor_left, { desc = " Move to Left Window" })
    map({ "n", "t" }, "<C-j>", require("smart-splits").move_cursor_down, { desc = " Move to Lower Window" })
    map({ "n", "t" }, "<C-k>", require("smart-splits").move_cursor_up, { desc = " Move to Upper Window" })
    map({ "n", "t" }, "<C-l>", require("smart-splits").move_cursor_right, { desc = " Move to Right Window" })

    map({ "n", "t" }, "<A-h>", require("smart-splits").resize_left, { desc = " Resize to Left Window" })
    map({ "n", "t" }, "<A-j>", require("smart-splits").resize_down, { desc = " Resize to Lower Window" })
    map({ "n", "t" }, "<A-k>", require("smart-splits").resize_up, { desc = " Resize to Upper Window" })
    map({ "n", "t" }, "<A-l>", require("smart-splits").resize_right, { desc = " Resize to Right Window" })

    -- Resize mode
    local submode = require("submode")
    submode.create("WinResize", {
      mode = "n",
      enter = "<leader>ws",
      leave = { "<Esc>", "q", "<C-c>" },
      hook = {
        on_enter = function()
          vim.notify(
            "Use { h, j, k, l } or { <Left>, <Down>, <Up>, <Right> } to resize the window\n"
              .. "Press <Esc>, q, or <C-c> to exit resize mode",
            vim.log.levels.WARN,
            { title = "Resize Mode", timeout = 7000 }
          )
        end,
        on_leave = function()
          vim.notify("You left resize mode", vim.log.levels.INFO, { title = "Resize Mode" })
        end,
        desc = "󰩨 Enter window resize mode",
      },
      default = function(register)
        register("h", require("smart-splits").resize_left, { desc = "❮ Resize left" })
        register("j", require("smart-splits").resize_down, { desc = " Resize down" })
        register("k", require("smart-splits").resize_up, { desc = " Resize up" })
        register("l", require("smart-splits").resize_right, { desc = "❯ Resize right" })
        register("<Left>", require("smart-splits").resize_left, { desc = "❮ Resize left" })
        register("<Down>", require("smart-splits").resize_down, { desc = " Resize down" })
        register("<Up>", require("smart-splits").resize_up, { desc = " Resize up" })
        register("<Right>", require("smart-splits").resize_right, { desc = "❯ Resize right" })
      end,
    })

    -- Swap buffer mode (Updated to follow cursor)
    submode.create("BufSwap", {
      mode = "n",
      enter = "<leader>wb",
      leave = { "<Esc>", "q", "<C-c>" },
      hook = {
        on_enter = function()
          vim.notify(
            "Use { h, j, k, l } or { <Left>, <Down>, <Up>, <Right> } to swap buffers \n"
              .. "Press <Esc>, q, or <C-c> to exit swap mode",
            vim.log.levels.WARN,
            { title = "Swap Buffer Mode", timeout = 7000 }
          )
        end,
        on_leave = function()
          vim.notify("You left swap buffer mode", vim.log.levels.INFO, { title = "Swap Buffer Mode" })
        end,
      },
      default = function(register)
        -- stylua: ignore start
        register("h", function() require("smart-splits").swap_buf_left() end, { desc = "❮ Swap buffer left and follow" })
        register("j", function() require("smart-splits").swap_buf_down() end, { desc = " Swap buffer down and follow" })
        register("k", function() require("smart-splits").swap_buf_up() end, { desc = " Swap buffer up and follow" })
        register("l", function() require("smart-splits").swap_buf_right() end, { desc = "❯ Swap buffer right and follow" })
        register("<Left>", function() require("smart-splits").swap_buf_left() end, { desc = "❮ Swap buffer left and follow" })
        register("<Down>", function() require("smart-splits").swap_buf_down() end, { desc = " Swap buffer down and follow" })
        register("<Up>", function() require("smart-splits").swap_buf_up() end, { desc = " Swap buffer up and follow" })
        register("<Right>", function() require("smart-splits").swap_buf_right() end, { desc = "❯ Swap buffer right and follow" })
        -- stylua: ignore end
      end,
      desc = "󰓡 Enter window swap mode",
    })
  end,
}
