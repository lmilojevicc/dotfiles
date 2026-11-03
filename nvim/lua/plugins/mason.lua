return {
  {
    "mason-org/mason.nvim",
    event = "VeryLazy",
    cmd = { "Mason" },
    opts = {
      registries = {
        "lua:mason-registry.index",
        "github:mason-org/mason-registry",
      },
      ui = {
        border = "rounded",
        icons = {
          package_installed = "✓",
          package_pending = "➜",
          package_uninstalled = "✗",
        },
      },
    },
    keys = {
      { "<leader>ms", "<cmd>Mason<CR>", desc = "󰽤 Open Mason" },
    },
  },
  {
    "mason-org/mason-lspconfig.nvim",
    event = "VeryLazy",
    dependencies = {
      "mason-org/mason.nvim",
      -- Load blink's plugin/ file first so its capabilities are in vim.lsp.config("*") before servers start.
      "saghen/blink.cmp",
    },
    opts = {
      ensure_installed = {
        "basedpyright",
        "bashls",
        "biome",
        "clangd",
        "cssls",
        "docker_language_server",
        "emmet_language_server",
        "eslint",
        "gopls",
        "html",
        "jsonls",
        "lemminx",
        "lua_ls",
        "markdown_oxide",
        "neocmake",
        "oxlint",
        "postgres_lsp",
        "ruff",
        "rumdl",
        "rust_analyzer",
        "tailwindcss",
        "taplo",
        "vtsls",
        "yamlls",
        "zls",
      },

      automatic_enable = {
        exclude = {
          -- Its .NET build needs libicu, which this host does not have.
          "marksman",
          -- Formatting goes through conform (config/project-tooling.lua).
          "oxfmt",
          "rumdl",
          "stylua",
        },
      },
    },
  },
  {
    "WhoIsSethDaniel/mason-tool-installer.nvim",
    dependencies = { "mason-org/mason.nvim" },
    event = "VeryLazy",
    -- Its own VimEnter check has already fired by the time VeryLazy loads it.
    config = function(_, opts)
      local installer = require("mason-tool-installer")
      installer.setup(opts)
      installer.check_install()
    end,
    opts = {
      ensure_installed = {
        "actionlint",
        "biome",
        "clang-format",
        "cmakelang",
        "cmakelint",
        "codelldb",
        "delve",
        "eslint_d",
        "go-debug-adapter",
        "gofumpt",
        "goimports",
        "golangci-lint",
        "golines",
        "gomodifytags",
        "google-java-format",
        "gotests",
        "impl",
        "hadolint",
        "js-debug-adapter",
        "json2go",
        "markdown-oxide",
        "oxfmt",
        "prettierd",
        "rumdl",
        "shellcheck",
        "shfmt",
        "sqruff",
        "stylua",
        "yamlfmt",
      },
    },
  },
}
