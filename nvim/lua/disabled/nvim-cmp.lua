return {
  "hrsh7th/nvim-cmp",
  event = { "InsertEnter", "CmdLineEnter" },
  dependencies = {
    "hrsh7th/cmp-buffer",
    "hrsh7th/cmp-path",
    "hrsh7th/cmp-cmdline",
    "hrsh7th/cmp-nvim-lsp-signature-help",
    "L3MON4D3/LuaSnip",
    "saadparwaiz1/cmp_luasnip",
    "rafamadriz/friendly-snippets",
    "onsails/lspkind.nvim",
  },
  config = function()
    local cmp = require("cmp")
    local luasnip = require("luasnip")
    local lspkind = require("lspkind")

    -- Load vscode style snippets
    require("luasnip.loaders.from_vscode").lazy_load()

    cmp.setup({
      completion = {
        completeopt = "menu,menuone,preview,noselect",
      },
      window = {
        completion = {
          border = "rounded",
          scrollbar = true,
          scrolloff = 5,
        },
        documentation = {
          max_height = 15,
          max_width = 30,
          border = "rounded",
          scrollbar = true,
          scrolloff = 5,
        },
      },
      snippet = {
        expand = function(args)
          luasnip.lsp_expand(args.body)
        end,
      },
      mapping = {
        ["<Up>"] = cmp.mapping({
          i = cmp.mapping.select_prev_item(),
          c = cmp.mapping.select_prev_item(),
        }, { desc = "Select previous item in completion menu" }),

        ["<Down>"] = cmp.mapping({
          i = cmp.mapping.select_next_item(),
          c = cmp.mapping.select_next_item(),
        }, { desc = "Select next item in completion menu" }),

        ["<S-Tab>"] = cmp.mapping({
          i = cmp.mapping.select_prev_item(),
          c = cmp.mapping.select_prev_item(),
        }, { desc = "Select previous item in completion menu" }),

        ["<Tab>"] = cmp.mapping({
          i = cmp.mapping.select_next_item(),
          c = cmp.mapping.select_next_item(),
        }, { desc = "Select next item in completion menu" }),

        ["<C-b>"] = cmp.mapping({
          i = cmp.mapping.scroll_docs(-4),
          c = cmp.mapping.scroll_docs(-4),
        }, { desc = "Scroll documentation window up" }),

        ["<C-f>"] = cmp.mapping({
          i = cmp.mapping.scroll_docs(4),
          c = cmp.mapping.scroll_docs(4),
        }, { desc = "Scroll documentation window down" }),

        ["<C-Enter>"] = cmp.mapping({
          i = cmp.mapping.complete(),
          c = cmp.mapping.complete(),
        }, { desc = "Show completion suggestions" }),

        ["<C-e>"] = cmp.mapping({
          i = cmp.mapping.abort(),
          c = cmp.mapping.abort(),
        }, { desc = "Close completion window" }),

        ["<CR>"] = cmp.mapping({
          i = cmp.mapping.confirm({ select = false }),
          c = cmp.mapping.confirm({ select = false }),
        }, { desc = "Confirm selection" }),
      },

      -- Add sources for autocompletion
      sources = cmp.config.sources({
        { name = "nvim_lsp" },
        { name = "nvim_lsp_signature_help" },
        { name = "luasnip" },
        { name = "buffer" },
        { name = "path" },
      }),

      -- Formatting with vscode-like pictograms
      formatting = {
        format = lspkind.cmp_format({
          maxwidth = 50,
          ellipsis_char = "...",
        }),
      },
    })

    cmp.setup.cmdline(":", {
      mapping = cmp.mapping.preset.cmdline(),
      sources = cmp.config.sources({
        { name = "path" },
      }, {
        { name = "cmdline" },
      }),
    })

    cmp.setup.cmdline("/", {
      mapping = cmp.mapping.preset.cmdline(),
      sources = {
        { name = "buffer" },
      },
    })
  end,
}
