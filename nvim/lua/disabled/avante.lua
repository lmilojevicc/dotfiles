return {
  "yetone/avante.nvim",
  event = "VeryLazy",
  version = false,
  build = "make",
  dependencies = {
    "nvim-lua/plenary.nvim",
    "MunifTanjim/nui.nvim",
    "nvim-mini/mini.icons",
    {
      "MeanderingProgrammer/render-markdown.nvim",
      opts = {
        file_types = { "markdown", "norg", "rmd", "org", "Avante" },
      },
      ft = { "Avante" },
    },
  },
  ---@module "avante"
  ---@type avante.Config
  opts = {
    provider = "gemini-cli",
    selector = {
      provider = "snacks",
    },
    input = {
      provider = "snacks",
      provider_opts = {
        title = "Avante Input",
        icon = " ",
      },
    },
    acp_providers = {
      ["gemini-cli"] = {
        command = "gemini",
        args = { "--acp" },
        auth_method = "oauth-personal",
      },
    },
  },

  -- stylua: ignore
  keys = {
    { "<leader>aa", function() require("avante.api").ask() end, mode = { "n", "v" }, desc = "󰚩 Avante ask", },
    { "<leader>an", function() require("avante.api").ask({ new_chat = true }) end, mode = { "n", "v" }, desc = "󰈔 Avante new chat", },
    { "<leader>az", function() require("avante.api").zen_mode() end, mode = { "n", "v" }, desc = "󰾞 Avante zen mode", },
    { "<leader>ae", function() require("avante.api").edit() end, mode = "v", desc = " Avante edit", },
    { "<leader>at", function() require("avante").toggle() end, desc = "󰚩 Avante toggle", },
    { "<leader>af", function() require("avante.api").focus() end, desc = "󰍉 Avante focus", },
    { "<leader>ar", function() require("avante.api").refresh() end, desc = " Avante refresh", },
    { "<leader>aS", function() require("avante.api").stop() end, desc = "󰅖 Avante stop", },
    { "<leader>a?", function() require("avante.api").select_model() end, desc = "󰚩 Avante models", },
    { "<leader>ah", function() require("avante.api").select_history() end, desc = " Avante history", },
    { "<leader>aM", function() require("avante.api").select_acp_model() end, desc = "󰚩 Avante ACP model", },
    { "<leader>am", function() require("avante.api").select_acp_mode() end, desc = " Avante ACP mode", },
    { "<leader>ac", function() local path = vim.api.nvim_buf_get_name(0) if path ~= "" then require("avante.api").add_selected_file(path) end end, desc = "󰆓 Avante add current file", },
    { "<leader>aB", function() require("avante.api").add_buffer_files() end, desc = " Avante add open buffers", },
  },
}
