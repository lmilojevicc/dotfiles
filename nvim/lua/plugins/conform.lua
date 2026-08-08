-- Keep rumdl's Markdown lint/format cache out of project directories.
vim.env.RUMDL_CACHE_DIR = vim.fn.stdpath("cache") .. "/rumdl"

return {
  "stevearc/conform.nvim",
  event = { "BufReadPre", "BufNewFile" },
  config = function()
    local conform = require("conform")

    conform.setup({
      formatters_by_ft = {
        lua = { "stylua" },
        c = { "clang-format" },
        cpp = { "clang-format" },
        java = { "google-java-format" },
        go = { "gofumpt", "goimports", "golines" },
        bash = { "shfmt" },
        zsh = { "shfmt" },
        sh = { "shfmt" },
        javascript = { "biome", "prettierd", "prettier", stop_after_first = true },
        typescript = { "biome", "prettierd", "prettier", stop_after_first = true },
        javascriptreact = { "biome", "prettierd", "prettier", stop_after_first = true },
        typescriptreact = { "biome", "prettierd", "prettier", stop_after_first = true },
        html = { "prettierd", "prettier", stop_after_first = true },
        css = { "biome", "prettierd", "prettier", stop_after_first = true },
        json = { "biome", "prettierd", "prettier", stop_after_first = true },
        graphql = { "biome", "prettierd", "prettier", stop_after_first = true },
        markdown = { "prettierd", "rumdl" },
        jsx = { "prettierd", "prettier", stop_after_first = true },
        tsx = { "prettierd", "prettier", stop_after_first = true },
        sql = { "sqruff", stop_after_first = true },
        yaml = { "yamlfmt" },
        toml = { "taplo" },
        python = { "ruff_format", "ruff_organize_imports" },
      },

      formatters = {
        taplo = {
          append_args = function(_, ctx)
            -- Prefer project-level taplo config if it exists.
            local cfg = vim.fs.find({ ".taplo.toml", "taplo.toml" }, {
              upward = true,
              path = ctx.dirname,
            })
            if #cfg > 0 then
              return {}
            end
            return {
              "--option", "indent_tables=true",
              "--option", "indent_entries=true",
            }
          end,
        },
      },

      format_after_save = function(bufnr)
        if vim.g.disable_autoformat or vim.b[bufnr].disable_autoformat then
          return
        end
        return { async = true, lsp_fallback = true }
      end,
    })
  end,

  -- stylua: ignore
  keys = {
    { "<leader>fo", function() require("conform").format({ async = true, lsp_fallback = true }) end, { desc = " Format file or selection" } },
  },
}
