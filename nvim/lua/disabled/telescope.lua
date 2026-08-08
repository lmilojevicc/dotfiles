return {
  "nvim-telescope/telescope.nvim",
  event = { "VeryLazy" },
  dependencies = {
    "nvim-telescope/telescope-ui-select.nvim",
  },
  config = function()
    require("telescope").setup({
      defaults = {
        file_ignore_patterns = { "node_modules/.*", ".git/.*", ".venv/.*" },
      },
      pickers = {
        find_files = {
          hidden = true,
          find_command = { "rg", "--files", "--hidden", "--no-ignore-vcs" },
        },
        live_grep = {
          additional_args = function()
            return {
              "--hidden",
              "--glob",
              "!**/.git/*",
              "--glob",
              "!**/.venv/*",
              "--glob",
              "!**/node_modules/*",
            }
          end,
        },
      },
      extensions = {
        ["ui-select"] = {
          require("telescope.themes").get_dropdown({}),
        },
      },
    })

    require("telescope").load_extension("ui-select")
  end,

  --stylua: ignore
  keys = {
    { "<leader>ff", function() require("telescope.builtin").find_files() end, desc = " Find files", },
    { "<leader>fw", function() require("telescope.builtin").live_grep() end, desc = " Search text in project", },
    { "<leader>fb", function() require("telescope.builtin").buffers() end, desc = " List open buffers", },
    { "<leader>wk", function() require("telescope.builtin").keymaps() end, desc = " List keymaps", },
  },
}
