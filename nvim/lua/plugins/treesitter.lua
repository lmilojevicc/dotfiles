return {
  "nvim-treesitter/nvim-treesitter",
  branch = "main",
  event = "BufReadPre",
  build = ":TSUpdate",
  dependencies = {
    {
      "nvim-treesitter/nvim-treesitter-textobjects",
      branch = "main",
      event = "BufReadPre",
    },
    {
      "bezhermoso/tree-sitter-ghostty",
      build = "make nvim_install",
      event = "BufReadPre",
    },
  },
  config = function()
    local languages = {
      "bash",
      "c",
      "cmake",
      "cpp",
      "diff",
      "dockerfile",
      "git_config",
      "git_rebase",
      "gitattributes",
      "gitcommit",
      "gitignore",
      "gomod",
      "gosum",
      "gowork",
      "html",
      "java",
      "javascript",
      "jsdoc",
      "json",
      "lua",
      "luadoc",
      "luap",
      "markdown",
      "markdown_inline",
      "printf",
      "python",
      "query",
      "regex",
      "rust",
      "sql",
      "tmux",
      "toml",
      "tsx",
      "typescript",
      "vim",
      "vimdoc",
      "xml",
      "yaml",
      "zig",
      "zsh",
    }
    local ts = require("nvim-treesitter")
    local ts_textobjects = require("nvim-treesitter-textobjects")
    local ts_select = require("nvim-treesitter-textobjects.select")
    local pending_installs = {}

    ts.install(languages)

    ts_textobjects.setup({
      select = {
        lookahead = true,
        selection_modes = {
          ["@function.outer"] = "V",
        },
      },
    })

    vim.keymap.set({ "x", "o" }, "af", function()
      ts_select.select_textobject("@function.outer", "textobjects")
    end, { desc = "TreeSitter around function" })

    vim.keymap.set({ "x", "o" }, "if", function()
      ts_select.select_textobject("@function.inner", "textobjects")
    end, { desc = "TreeSitter inside function" })

    local group = vim.api.nvim_create_augroup("treesitter_filetype", { clear = true })

    vim.api.nvim_create_autocmd("FileType", {
      group = group,
      callback = function(args)
        local buf = args.buf
        local filetype = vim.bo[buf].filetype
        local lang = vim.treesitter.language.get_lang(filetype) or filetype

        if lang == "" then
          return
        end

        local loaded = vim.treesitter.language.add(lang)
        if loaded then
          vim.bo[buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
          pcall(vim.treesitter.start, buf, lang)
          return
        end

        -- Parser not available, try to install if possible
        if pending_installs[lang] then
          return
        end

        if not vim.tbl_contains(ts.get_available(), lang) then
          return
        end

        pending_installs[lang] = true
        local task = ts.install(lang)

        if task and task.await then
          task:await(function(err, success)
            pending_installs[lang] = nil

            if err or not success then
              return
            end

            vim.schedule(function()
              if not vim.api.nvim_buf_is_valid(buf) then
                return
              end

              local add_ok = vim.treesitter.language.add(lang)
              if add_ok then
                vim.bo[buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
                vim.treesitter.stop(buf)
                pcall(vim.treesitter.start, buf, lang)
              end
            end)
          end)
        else
          pending_installs[lang] = nil
        end
      end,
    })
  end,
}
