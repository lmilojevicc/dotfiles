return {
  "toppair/peek.nvim",
  build = "deno task --quiet build:fast",
  ft = "markdown",
  config = function()
    require("peek").setup({
      auto_load = true, -- automatically loads preview when entering markdown buffer
      close_on_bdelete = false, -- close preview when changing/closing buffer
      syntax = true, -- enable syntax highlighting
      theme = "dark", -- 'dark' or 'light'
      update_on_change = true,
      app = "browser",
    })

    -- Create user commands
    vim.api.nvim_create_user_command("PeekOpen", require("peek").open, {})
    vim.api.nvim_create_user_command("PeekClose", require("peek").close, {})
  end,

  --stylua: ignore
  keys = {
    { "<leader>mo", function() require("peek").open() end, desc = " Peek Open Markdown Preview" },
    { "<leader>mc", function() require("peek").close() end, desc = " Peek Close Markdown Preview" },
  },
}
