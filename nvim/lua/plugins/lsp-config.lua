return {
  "neovim/nvim-lspconfig",
  event = { "BufReadPre", "BufNewFile" },
  dependencies = {
    "mason-org/mason.nvim",
    "mason-org/mason-lspconfig.nvim",
  },
  config = function()
    local lsp = vim.lsp.config
    lsp["lua_ls"] = {
      settings = {
        Lua = {
          telemetry = {
            enable = false,
          },
          hint = {
            enable = true,
          },
        },
      },
    }
    lsp["basedpyright"] = {
      settings = {
        basedpyright = {
          analysis = {
            typeCheckingMode = "basic",
            diagnosticSeverityOverrides = {
              reportUnknownMemberType = false,
              reportMissingTypeStubs = false,
              reportUnknownArgumentType = false,
              reportUnusedImport = "none",
            },
          },
        },
      },
    }
    lsp["yamlls"] = {
      capabilities = {
        textDocument = {
          foldingRange = {
            dynamicRegistration = false,
            lineFoldingOnly = true,
          },
        },
      },
      before_init = function(_, new_config)
        new_config.settings.yaml.schemas =
          vim.tbl_deep_extend("force", new_config.settings.yaml.schemas or {}, require("schemastore").yaml.schemas())
      end,
      settings = {
        redhat = { telemetry = { enabled = false } },
        yaml = {
          keyOrdering = false,
          format = {
            enable = true,
          },
          validate = true,
          schemaStore = {
            -- Must disable built-in schemaStore support to use
            -- schemas from SchemaStore.nvim plugin
            enable = false,
            -- Avoid TypeError: Cannot read properties of undefined (reading 'length')
            url = "",
          },
        },
      },
    }
    lsp["bashls"] = {
      filetypes = { "sh", "bash", "zsh" },
    }
    lsp["jsonls"] = {
      settings = {
        json = {
          format = { enable = true },
          validate = { enable = true },
        },
      },
    }
    lsp["gopls"] = {
      settings = {
        gopls = {
          gofumpt = true,
          codelenses = {
            gc_details = false,
            generate = true,
            regenerate_cgo = true,
            run_govulncheck = true,
            test = true,
            tidy = true,
            upgrade_dependency = true,
            vendor = true,
          },
          hints = {
            assignVariableTypes = true,
            compositeLiteralFields = true,
            compositeLiteralTypes = true,
            constantValues = true,
            functionTypeParameters = true,
            parameterNames = true,
            rangeVariableTypes = true,
          },
          analyses = {
            nilness = true,
            unusedparams = true,
            unusedwrite = true,
            useany = true,
          },
          usePlaceholders = true,
          completeUnimported = true,
          staticcheck = true,
          directoryFilters = { "-.git", "-.vscode", "-.idea", "-.vscode-test", "-node_modules" },
        },
      },
    }
    lsp["vtsls"] = {
      settings = {
        complete_function_calls = true,
        vtsls = {
          enableMoveToFileCodeAction = true,
          autoUseWorkspaceTsdk = true,
          experimental = {
            maxInlayHintLength = 30,
            completion = {
              enableServerSideFuzzyMatch = true,
              entriesLimit = 50,
            },
          },
        },

        typescript = {
          updateImportsOnFileMove = { enabled = "always" },
          preferences = {
            includePackageJsonAutoImports = "auto",
            importModuleSpecifier = "shortest",
            quoteStyle = "auto",
          },

          suggest = {
            completeFunctionCalls = true,
            autoImports = true,
            objectLiteralMethodSnippets = { enabled = true },
          },

          inlayHints = {
            enumMemberValues = { enabled = true },
            functionLikeReturnTypes = { enabled = true },
            parameterNames = { enabled = "literals" },
            parameterTypes = {
              enabled = true,
              suppressWhenArgumentMatchesName = true,
            },
            propertyDeclarationTypes = { enabled = true },
            variableTypes = { enabled = false },
          },

          validate = {
            enable = true,
          },

          format = {
            enable = true,
            semicolons = "insert",
            insertSpaceAfterCommaDelimiter = true,
            insertSpaceAfterSemicolonInForStatements = true,
          },

          referencesCodeLens = {
            enabled = true,
            showOnAllFunctions = false,
          },
          implementationsCodeLens = {
            enabled = true,
          },
        },

        javascript = {
          updateImportsOnFileMove = { enabled = "always" },
          preferences = {
            includePackageJsonAutoImports = "auto",
            importModuleSpecifier = "shortest",
            quoteStyle = "auto",
          },

          suggest = {
            completeFunctionCalls = true,
            autoImports = true,
            objectLiteralMethodSnippets = { enabled = true },
          },

          inlayHints = {
            enumMemberValues = { enabled = true },
            functionLikeReturnTypes = { enabled = true },
            parameterNames = { enabled = "literals" },
            parameterTypes = {
              enabled = true,
              suppressWhenArgumentMatchesName = true,
            },
            propertyDeclarationTypes = { enabled = true },
            variableTypes = { enabled = false },
          },

          validate = {
            enable = true,
          },

          format = {
            enable = true,
            semicolons = "insert",
            insertSpaceAfterCommaDelimiter = true,
            insertSpaceAfterSemicolonInForStatements = true,
          },
        },
      },
    }
    lsp["emmet_language_server"] = {
      filetypes = {
        "css",
        "html",
        "javascript",
        "javascriptreact",
        "less",
        "sass",
        "scss",
        "svelte",
        "typescriptreact",
        "vue",
      },
      settings = {
        emmet = {
          showExpandedAbbreviation = "always",
          showAbbreviationSuggestions = true,
          showSuggestionsAsSnippets = false,
          preferences = { ["bem.enabled"] = true },
        },
      },
    }
    lsp["tailwindcss"] = {
      filetypes = {
        "aspnetcorerazor",
        "astro",
        "astro-markdown",
        "blade",
        "clojure",
        "django-html",
        "htmldjango",
        "edge",
        "eelixir",
        "elixir",
        "ejs",
        "erb",
        "eruby",
        "gohtml",
        "gohtmltmpl",
        "haml",
        "handlebars",
        "hbs",
        "html",
        "htmlangular",
        "html-eex",
        "heex",
        "jade",
        "leaf",
        "liquid",
        "mdx",
        "mustache",
        "njk",
        "nunjucks",
        "php",
        "razor",
        "slim",
        "twig",
        "css",
        "less",
        "postcss",
        "sass",
        "scss",
        "stylus",
        "sugarss",
        "javascript",
        "javascriptreact",
        "reason",
        "rescript",
        "typescript",
        "typescriptreact",
        "vue",
        "svelte",
        "templ",
      },
    }
    lsp["biome"] = {}
  end,
}
