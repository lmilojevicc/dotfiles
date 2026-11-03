return {
  "nvimtools/none-ls.nvim",
  event = { "BufReadPre", "BufNewFile" },
  config = function()
    local null_ls = require("null-ls")
    local tooling = require("config.project-tooling")

    null_ls.setup({
      sources = {
        -- golangci-lint: the project's .golangci config when it has one,
        -- otherwise my preferred linter set.
        null_ls.builtins.diagnostics.golangci_lint.with({
          filetypes = { "go" },
          extra_args = function(params)
            if tooling.golangci_config(params.bufnr) then
              return {}
            end
            return {
              "--enable=bodyclose,gosec,errname,errorlint,"
                .. "wrapcheck,noctx,nilnil,nilerr,prealloc,predeclared,"
                .. "modernize,mnd,gocritic",
              "--disable=errcheck,unused",
            }
          end,
        }),
        null_ls.builtins.code_actions.gomodifytags.with({
          filetypes = { "go" },
        }),
        -- hadolint: Dockerfile linting
        null_ls.builtins.diagnostics.hadolint.with({
          filetypes = { "dockerfile" },
        }),
        -- SQL: sqlfluff when the project configures it, otherwise sqruff.
        null_ls.builtins.diagnostics.sqruff.with({
          filetypes = { "sql" },
          runtime_condition = function(params)
            return not tooling.uses_linter("sqlfluff", params.bufnr)
          end,
        }),
        null_ls.builtins.diagnostics.sqlfluff.with({
          filetypes = { "sql" },
          runtime_condition = function(params)
            return tooling.uses_linter("sqlfluff", params.bufnr)
          end,
        }),
        -- yamllint only where the project configures it.
        null_ls.builtins.diagnostics.yamllint.with({
          runtime_condition = function(params)
            return tooling.uses_linter("yamllint", params.bufnr)
          end,
        }),
        -- markdownlint-cli2 only where the project configures it.
        null_ls.builtins.diagnostics.markdownlint_cli2.with({
          runtime_condition = function(params)
            return tooling.uses_linter("markdownlint-cli2", params.bufnr)
          end,
        }),
        -- actionlint: GitHub Actions linting
        null_ls.builtins.diagnostics.actionlint.with({
          filetypes = { "yaml" },
          runtime_condition = function(params)
            local path = params.bufname
            return path:match("%.github/workflows/")
              or path:match("%.gitea/workflows/")
              or path:match("%.forgejo/workflows/")
          end,
        }),
      },
    })
  end,
}
