return {
  {
    "NvChad/nvterm",
    event = "VeryLazy",
    config = function()
      require("nvterm").setup({
        terminals = {
          shell = vim.o.shell,
          type_opts = {
            float = {
              relative = "editor",
              row = 0.3,
              col = 0.25,
              width = 0.5,
              height = 0.4,
              border = "single",
            },
            horizontal = { location = "rightbelow", split_ratio = 0.3 },
            vertical = { location = "rightbelow", split_ratio = 0.5 },
          },
        },
        behavior = {
          autoclose_on_quit = { enabled = false, confirm = true },
          close_on_exit = true,
          auto_insert = true,
        },
      })

      local map = vim.keymap.set
      map({ "n", "t" }, "<A-i>", function()
        require("nvterm.terminal").toggle("float")
      end, { desc = "󰨚 Toggle floating terminal" })

      map("n", "<leader>th", function()
        require("nvterm.terminal").toggle("horizontal")
      end, { desc = "󰨚 Toggle horizontal terminal" })

      map("n", "<leader>tv", function()
        require("nvterm.terminal").toggle("vertical")
      end, { desc = "󰨚 Toggle vertical terminal" })
    end,
  },
}
