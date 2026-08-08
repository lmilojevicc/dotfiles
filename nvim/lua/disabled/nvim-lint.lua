return {
  "mfussenegger/nvim-lint",
  event = { "BufReadPre", "BufNewFile" },
  config = function()
    local lint = require("lint")

    lint.linters_by_ft = {
      cmake = { "cmakelang", "cmakelint" },
      javascript = { "eslint_d" },
      typescript = { "eslint_d" },
      javascriptreact = { "eslint_d" },
      typescriptreact = { "eslint_d" },
      go = { "golangcilint" },
      dockerfile = { "hadolint" },
      sql = { "sqruff" },
    }

    local golangcilint = lint.linters.golangcilint
    table.insert(
      golangcilint.args,
      "--enable=staticcheck,bodyclose,gosec,exhaustruct,errname,errorlint,wrapcheck,noctx,nilnil,nilerr,prealloc,predeclared,modernize,mnd,gocritic"
    )
    table.insert(golangcilint.args, "--disable=errcheck")

    local lint_augroup = vim.api.nvim_create_augroup("lint", { clear = true })
    vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost", "InsertLeave" }, {
      group = lint_augroup,
      callback = function()
        lint.try_lint()
      end,
    })
  end,
}
