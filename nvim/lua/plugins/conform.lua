-- Keep rumdl's Markdown lint/format cache out of project directories.
vim.env.RUMDL_CACHE_DIR = vim.fn.stdpath("cache") .. "/rumdl"

return {
  "stevearc/conform.nvim",
  event = { "BufReadPre", "BufNewFile" },
  config = function()
    local conform = require("conform")
    local tooling = require("config.project-tooling")
    local web = tooling.formatters()
    local fmt = tooling.formatter_candidates

    conform.setup({
      default_format_opts = {
        lsp_format = "fallback",
      },

      -- Every file type: the formatter the project configures (nearest config
      -- wins), else my default. JS/TS defaults to oxfmt. See
      -- config/project-tooling.lua for how each tool is detected.
      formatters_by_ft = {
        lua = { "stylua" },
        c = { "clang-format" },
        cpp = { "clang-format" },
        java = { "google-java-format" },
        go = tooling.choose(fmt.go, { "goimports", "gofumpt", "golines" }),
        bash = { "shfmt" },
        zsh = { "shfmt" },
        sh = { "shfmt" },
        javascript = web,
        typescript = web,
        javascriptreact = web,
        typescriptreact = web,
        json = web,
        jsonc = web,
        json5 = web,
        css = web,
        scss = web,
        less = web,
        html = web,
        vue = web,
        graphql = web,
        -- No oxc formatter for these: the project's Prettier or Biome, else the LSP.
        svelte = tooling.formatters({}),
        astro = tooling.formatters({}),
        -- The project's oxfmt/Prettier, or its own tool for the type, else mine.
        markdown = tooling.web_or(fmt.markdown, { "rumdl", "injected" }),
        yaml = tooling.web_or(fmt.yaml, { "yamlfmt" }),
        toml = tooling.web_or(fmt.toml, { "taplo" }),
        sql = tooling.choose(fmt.sql, { "sqruff" }),
        python = tooling.choose(fmt.python, { "ruff_organize_imports", "ruff_format" }),
        rust = { "rustfmt" },
      },

      formatters = {
        biome = { require_cwd = true },
        -- Run where the project's golangci config lives so `fmt` finds it.
        ["golangci-lint"] = {
          cwd = require("conform.util").root_file({
            ".golangci.yml",
            ".golangci.yaml",
            ".golangci.toml",
            ".golangci.json",
          }),
        },
        -- Prefer the project's virtualenv copies.
        black = {
          command = require("conform.util").find_executable({ ".venv/bin/black", "venv/bin/black" }, "black"),
        },
        isort = {
          command = require("conform.util").find_executable({ ".venv/bin/isort", "venv/bin/isort" }, "isort"),
        },
        yapf = {
          command = require("conform.util").find_executable({ ".venv/bin/yapf", "venv/bin/yapf" }, "yapf"),
        },
        autopep8 = {
          command = require("conform.util").find_executable({ ".venv/bin/autopep8", "venv/bin/autopep8" }, "autopep8"),
        },
        sqlfluff = {
          command = require("conform.util").find_executable({ ".venv/bin/sqlfluff", "venv/bin/sqlfluff" }, "sqlfluff"),
        },
        -- A project's own ruff (its pinned version) before Mason's.
        ruff_format = {
          command = require("conform.util").find_executable({ ".venv/bin/ruff", "venv/bin/ruff" }, "ruff"),
        },
        ruff_organize_imports = {
          command = require("conform.util").find_executable({ ".venv/bin/ruff", "venv/bin/ruff" }, "ruff"),
        },
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
              "--option",
              "indent_tables=true",
              "--option",
              "indent_entries=true",
            }
          end,
        },
      },

      format_after_save = function(bufnr)
        if vim.g.disable_autoformat or vim.b[bufnr].disable_autoformat then
          return
        end
        return { async = true }
      end,
    })
  end,

  -- stylua: ignore
  keys = {
    {
      "<leader>fo",
      function() require("conform").format({ async = true }) end,
      mode = { "n", "v" },
      desc = " Format file or selection",
    },
  },
}
