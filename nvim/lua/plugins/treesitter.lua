return {
  "nvim-treesitter/nvim-treesitter",
  branch = "main",
  event = { "BufReadPre", "BufNewFile" },
  build = ":TSUpdate",
  dependencies = {
    { "nvim-treesitter/nvim-treesitter-textobjects", branch = "main",             event = "BufReadPre", },
    { "bezhermoso/tree-sitter-ghostty",              build = "make nvim_install", event = "BufReadPre", },
  },
  config = function()
    local languages = {
      "bash",
      "c",
      "cmake",
      "cpp",
      "css",
      "diff",
      "dockerfile",
      "git_config",
      "git_rebase",
      "gitattributes",
      "gitcommit",
      "gitignore",
      "go",
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
      "mermaid",
      "printf",
      "python",
      "query",
      "regex",
      "rust",
      "sql",
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
    local available_languages = {}
    for _, lang in ipairs(ts.get_available()) do
      available_languages[lang] = true
    end

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

    local treesitter_indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
    local prior_indentexpr = {}
    local pending_installs = {}

    local function clear_indent(buf)
      if vim.bo[buf].indentexpr == treesitter_indentexpr then
        vim.bo[buf].indentexpr = prior_indentexpr[buf] or ""
      end
      prior_indentexpr[buf] = nil
    end

    local function activate(buf)
      if not vim.api.nvim_buf_is_valid(buf) or not vim.api.nvim_buf_is_loaded(buf) then
        return
      end

      local filetype = vim.bo[buf].filetype
      local lang = vim.treesitter.language.get_lang(filetype) or filetype
      local language_ok, language_loaded = false, false
      if lang ~= "" then
        language_ok, language_loaded = pcall(vim.treesitter.language.add, lang)
      end
      if not language_ok or language_loaded ~= true then
        clear_indent(buf)
        if vim.treesitter.highlighter.active[buf] then
          vim.treesitter.stop(buf)
        end
        return lang, false
      end

      local indent_ok, indents = pcall(vim.treesitter.query.get, lang, "indents")
      if indent_ok and indents then
        if vim.bo[buf].indentexpr ~= treesitter_indentexpr then
          prior_indentexpr[buf] = vim.bo[buf].indentexpr
        end
        vim.bo[buf].indentexpr = treesitter_indentexpr
      else
        clear_indent(buf)
      end

      local highlight_ok, highlights = pcall(vim.treesitter.query.get, lang, "highlights")
      -- Avoid restarts: Neovim retains parser callbacks across stop/start cycles.
      local active = vim.treesitter.highlighter.active[buf]
      if not highlight_ok or not highlights then
        if active then
          vim.treesitter.stop(buf)
        end
        return lang, true
      end

      if active and active.tree:lang() == lang then
        return lang, true
      end
      if active then
        vim.treesitter.stop(buf)
      end
      pcall(vim.treesitter.start, buf, lang)
      return lang, true
    end

    local function install_missing(buf, lang)
      local waiting = pending_installs[lang]
      if waiting then
        waiting[buf] = true
        return
      end

      waiting = { [buf] = true }
      pending_installs[lang] = waiting
      local finished = false

      local function complete(err, success)
        if finished then
          return
        end
        finished = true
        if pending_installs[lang] == waiting then
          pending_installs[lang] = nil
        end

        vim.schedule(function()
          if err or not success then
            local detail = tostring(err or "no error reported"):match("^[^\n]+")
            vim.notify(
              ("nvim-treesitter parser install failed for %s (success=%s): %s"):format(lang, success, detail),
              vim.log.levels.WARN
            )
          end

          for waiting_buf in pairs(waiting) do
            activate(waiting_buf)
          end
        end)
      end

      local install_ok, task = pcall(ts.install, { lang })
      if install_ok and task and task.await then
        task:await(complete)
      else
        complete(install_ok and "install did not return a task" or task, false)
      end
    end

    local group = vim.api.nvim_create_augroup("treesitter_filetype", { clear = true })

    vim.api.nvim_create_autocmd("FileType", {
      group = group,
      callback = function(args)
        local lang, language_loaded = activate(args.buf)
        if lang and lang ~= "" and not language_loaded and available_languages[lang] then
          install_missing(args.buf, lang)
        end
      end,
    })

    local install_task = ts.install(languages)
    if install_task and install_task.await then
      install_task:await(function(err, success)
        vim.schedule(function()
          if err or not success then
            local detail = tostring(err or "no error reported"):match("^[^\n]+")
            vim.notify(
              ("nvim-treesitter parser install failed (success=%s): %s"):format(success, detail),
              vim.log.levels.WARN
            )
          end

          for _, buf in ipairs(vim.api.nvim_list_bufs()) do
            activate(buf)
          end
        end)
      end)
    end
  end,
}
