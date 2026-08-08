return {
  "nvimtools/none-ls.nvim",
  event = { "BufReadPre", "BufNewFile" },
  dependencies = {
    "nvimtools/none-ls-extras.nvim",
  },
  config = function()
    local null_ls = require("null-ls")

    null_ls.setup({
      sources = {
        -- golangci-lint: Go linting
        null_ls.builtins.diagnostics.golangci_lint.with({
          filetypes = { "go" },
          args = {
            "run",
            "--output.json.path",
            "stdout",
            "--show-stats=false",
            "--issues-exit-code=1",
            "--enable=bodyclose,gosec,errname,errorlint,"
              .. "wrapcheck,noctx,nilnil,nilerr,prealloc,predeclared,"
              .. "modernize,mnd,gocritic",
            "--disable=errcheck,unused",
          },
        }),
        null_ls.builtins.code_actions.gomodifytags.with({
          filetypes = { "go" },
        }),
        -- hadolint: Dockerfile linting
        null_ls.builtins.diagnostics.hadolint.with({
          filetypes = { "dockerfile" },
        }),
        -- sqruff: SQL linting
        null_ls.builtins.diagnostics.sqruff.with({
          filetypes = { "sql" },
        }),
        -- actionlint: GitHub Actions linting
        null_ls.builtins.diagnostics.actionlint.with({
          filetypes = { "yaml", "yml" },
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
