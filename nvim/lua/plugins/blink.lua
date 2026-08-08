return {
  "saghen/blink.cmp",
  event = { "InsertEnter", "CmdlineEnter" },
  build = function()
    require("blink.cmp").build():pwait()
  end,
  opts_extend = {
    "sources.completion.enabled_providers",
    "sources.compat",
    "sources.default",
  },
  dependencies = {
    "kristijanhusak/vim-dadbod-completion",
    "ribru17/blink-cmp-spell",
    {
      "saghen/blink.compat",
      event = { "InsertEnter", "CmdlineEnter" },
      opts = {},
    },
    {
      "L3MON4D3/LuaSnip",
      build = "make install_jsregexp",
      lazy = true,
      dependencies = {
        "rafamadriz/friendly-snippets",
        config = function()
          require("luasnip.loaders.from_vscode").lazy_load()
          require("luasnip.loaders.from_vscode").lazy_load({
            paths = { vim.fn.stdpath("config") .. "/snippets" .. "/vscode" },
          })
          require("luasnip.loaders.from_lua").lazy_load({
            paths = { vim.fn.stdpath("config") .. "/snippets" .. "/lua" },
          })
        end,
      },
      opts = {
        region_check_events = "InsertEnter,CursorMoved",
        delete_check_events = "TextChanged,InsertLeave",
      },
    },
  },
  ---@module 'blink.cmp'
  ---@type blink.cmp.Config
  opts = {
    keymap = {
      preset = "super-tab",
    },
    cmdline = {
      keymap = { preset = "inherit" },
      completion = { menu = { auto_show = true } },
    },
    appearance = { nerd_font_variant = "mono" },
    signature = {
      window = { border = "none" },
    },
    completion = {
      accept = {
        auto_brackets = { enabled = true },
      },
      menu = {
        auto_show = true,
        scrollbar = false,
        border = "none",
        scrolloff = 5,
        draw = {
          treesitter = { "lsp" },
          gap = 3,
          columns = {
            { "kind_icon" },
            { "label", "label_description", gap = 1 },
            { "kind" },
          },
        },
      },
      ghost_text = { enabled = true },
      documentation = {
        auto_show = true,
        auto_show_delay_ms = 200,
        window = { border = "none" },
      },
    },
    snippets = {
      preset = "luasnip",
    },
    sources = {
      default = { "lsp", "lazydev", "dadbod", "snippets", "path", "buffer", "spell" },
      providers = {
        lsp = {
          name = "lsp",
          score_offset = 900,
        },
        lazydev = {
          name = "LazyDev",
          module = "lazydev.integrations.blink",
          score_offset = 950,
        },
        snippets = {
          name = "snippets",
          score_offset = 500,
          min_keyword_length = 2,
        },
        path = {
          name = "path",
          score_offset = 250,
          fallbacks = { "buffer" },
        },
        buffer = {
          name = "buffer",
          score_offset = 50,
          max_items = 8,
          min_keyword_length = 3,
        },
        dadbod = {
          name = "Dadbod",
          module = "vim_dadbod_completion.blink",
          score_offset = 950,
        },
        spell = {
          name = "Spell",
          module = "blink-cmp-spell",
        },
      },
    },
    fuzzy = {
      implementation = "prefer_rust_with_warning",
      sorts = {
        "exact",
        "score",
        "sort_text",
        "label",
      },
    },
  },
}
