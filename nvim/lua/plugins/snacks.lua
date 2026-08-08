---@module 'snacks'

return {
  "folke/snacks.nvim",
  priority = 1000,
  lazy = false,
  ---@type snacks.Config
  opts = {
    input = {
      enabled = true,
      win = {
        relative = "cursor",
        width = 60,
        row = -3,
        col = 0,
        style = "input",
      },
    },
    picker = {
      layout = {
        preset = "telescope",
      },
      layouts = {
        telescope = {
          reverse = false,
          layout = {
            box = "horizontal",
            backdrop = false,
            height = 0.8,
            width = 0.9,
            border = "none",
            {
              box = "vertical",
              {
                win = "input",
                height = 1,
                border = "rounded",
                title = "{title} {live} {flags}",
                title_pos = "center",
              },
              { win = "list", title = " Results ", title_pos = "center", border = "rounded" },
            },
            {
              win = "preview",
              title = "{preview:Preview}",
              width = 0.51,
              border = "rounded",
              title_pos = "center",
            },
          },
        },
      },
      files = {
        hidden = true,
      },
      sources = {
        explorer = {
          auto_close = true,
          hidden = true,
          ignored = true,
          win = {
            list = {
              keys = {
                ["<CR>"] = "recursive_toggle",
                ["l"] = "confirm_nofocus",
                ["L"] = "confirm",
              },
            },
          },
          actions = {
            -- Add preview for floating explorer
            bufadd = function(_, item)
              if vim.fn.bufexists(item.file) == 0 then
                local buf = vim.api.nvim_create_buf(true, false)
                vim.api.nvim_buf_set_name(buf, item.file)
                vim.api.nvim_buf_call(buf, vim.cmd.edit)
              end
            end,
            confirm_nofocus = function(picker, item)
              if item.dir then
                picker:action("confirm")
              else
                picker:action("bufadd")
              end
            end,

            -- Expand empty nested dirs
            recursive_toggle = function(picker, item)
              local Actions = require("snacks.explorer.actions")
              local Tree = require("snacks.explorer.tree")

              local get_children = function(node)
                local children = {}
                for _, child in pairs(node.children) do
                  table.insert(children, child)
                end
                return children
              end

              local refresh = function()
                Actions.update(picker, { refresh = true })
              end

              ---@param node snacks.picker.explorer.Node
              local function toggle_recursive(node)
                Tree:toggle(node.path)
                refresh()
                vim.schedule(function()
                  local children = get_children(node)
                  if #children ~= 1 then
                    return
                  end
                  local child = children[1]
                  if not child.dir then
                    return
                  end
                  toggle_recursive(child)
                end)
              end

              --

              local node = Tree:node(item.file)
              if not node then
                return
              end

              if node.dir then
                toggle_recursive(node)
              else
                picker:action("confirm")
              end
            end,
          },
        },
        lsp_symbols = {
          tree = true,
          filter = {
            default = {
              "Array",
              "Class",
              "Constant",
              "Constructor",
              "Enum",
              "EnumMember",
              "Event",
              "Field",
              "File",
              "Function",
              "Interface",
              "Key",
              "Method",
              "Module",
              "Namespace",
              "Object",
              "Package",
              "Property",
              "Struct",
              "Variable",
            },
            markdown = true,
            help = true,
            lua = {
              "Function",
              "Method",
              "Table",
              "Module",
              "Variable",
              "Constant",
              "Property",
              "Field",
              "Key",
              "Object",
              "Array",
            },
          },
        },
      },
    },
    dashboard = {
      -- enabled = false,
      preset = {
        -- stylua: ignore
        keys = {
          { icon = " ", key = "f", desc = "Find File", action = function() Snacks.picker.files({ hidden = true }) end, },
          { icon = "󱎸 ", key = "g", desc = "RipGrep", action = ":lua Snacks.dashboard.pick('live_grep')" },
          { icon = "󰦛 ", key = "r", desc = "Restore Last Session", action = function() require("persistence").load() end, },
          { icon = " ", key = "R", desc = "Pick Session", action = function() require("persistence").select() end, },
          { icon = " ", key = "n", desc = "New File", action = ":ene | startinsert" },
          { icon = " ", key = "l", desc = "LazyGit", action = "<leader>lg" },
          { icon = "󰒲 ", key = "L", desc = "Lazy", action = ":Lazy", enabled = package.loaded.lazy ~= nil },
          { icon = " ", key = "m", desc = "Mason", action = ":Mason" },
          { icon = " ", key = "q", desc = "Quit", action = ":qa" },
        },
      },

      sections = {
        { section = "header", padding = 1 },
        {
          section = "terminal",
          icon = " ",
          title = "Recent Activity",
          height = 5,
          padding = 1,
          indent = 3,
          ttl = 5 * 60,
          enabled = function()
            return Snacks.git.get_root() ~= nil
          end,
          cmd = "git -P log -5 --oneline",
        },
        {
          section = "terminal",
          icon = " ",
          title = "Git Status",
          padding = 1,
          indent = 3,
          ttl = 5 * 60,
          enabled = function()
            return Snacks.git.get_root() ~= nil
          end,
          cmd = "git -P diff --stat -B -M -C",
        },
        { section = "startup" },
      },
    },
    explorer = { enabled = false, replace_netrw = true, auto_close = true },
    notifier = { enabled = true },
    bigfile = { enabled = true },
    quickfile = { enabled = true },
    terminal = { enabled = false },
    image = { enabled = true },
    words = { enabled = false },
    indent = { enabled = true },
    scroll = { enabled = false },
    zen = { enabled = true, toggles = { dim = false } },
    toggle = { enabled = true },
    lazygit = { enabled = true },
    statuscolumn = {
      enabled = true,
      left = { "sign", "fold" },
      right = { "git", "mark" },
      folds = {
        open = true,
        git_hl = false,
      },
      git = {
        patterns = { "GitSign", "MiniDiffSign" },
      },
      refresh = 50,
    },
  },

  -- stylua: ignore
  keys = {
    -- Zen
    { "<leader>zm", function() Snacks.zen() end, desc = "󰾞 Toggle Zen Mode" },
    { "<leader>zr", function() Snacks.zen({ win = { width = 0.4 } }) end, desc = "󰾞 Toggle Reader Zen Mode" },
    { "<leader>zc", function() Snacks.zen({ win = { width = 0.75 } }) end, desc = "󰾞 Toggle Code Zen Mode" },

    -- Lazygit
    { "<leader>lg", function() Snacks.lazygit.open() end, desc = " Open Lazygit", },
    { "<leader>ll", function() Snacks.lazygit.log() end, desc = " Lazygit log", },
    { "<leader>lf", function() Snacks.lazygit.log_file() end, desc = " Lazygit log of current file", },

    -- Notificiations
    { "<leader>nd", function() Snacks.notifier.hide() end, desc = "󰎟 Clear notifications", },
    { "<leader>nf", function() Snacks.picker.notifications() end, desc = " Search notifications", },
    { "<leader>ne", function() Snacks.picker.notifications({ filter = "error" }) end, desc = "󰎟 Show error notifications", },

    -- Explorer
    { "<leader>ee", function() Snacks.explorer.open() end, desc = " Open Snacks Explorer", },

    -- Buffer
    { "<leader>bd", function() Snacks.bufdelete() end, desc = " Delete current buffer (file or terminal)", },
    { "<leader>bo", function() Snacks.bufdelete.other() end, desc = " Delete other buffers", },

    -- Keymaps
    {
      "<leader>wk",
      function()
        Snacks.picker.keymaps({
          format = function(item, picker)
            -- Extract key from item.text (everything until the first space)
            local key = item.text and item.text:match("^[^%s]+") or ""

            -- Calculate lengths for alignment
            local mode = item.mode or ""
            local desc = item.item.desc or ""
            local mode_width = 5
            local key_width = 15
            local desc_width = 40

            -- Pad strings to fit the column widths
            local padded_mode = mode .. string.rep(" ", mode_width - #mode)
            local padded_key = key .. string.rep(" ", key_width - #key)
            local padded_desc = desc .. string.rep(" ", desc_width - #desc)

            return {
              { padded_mode, "csvCol2" },
              { padded_key,  "csvCol5" },
              { padded_desc, "csvCol8" },
            }
          end,
        })
      end,
      desc = " Search keymaps",
    },

    -- LSP
    { "gr", function() Snacks.picker.lsp_references() end, desc = " Show LSP references", },
    { "gD", function() Snacks.picker.lsp_declarations() end, desc = " Go to declaration", },
    { "gd", function() Snacks.picker.lsp_definitions() end, desc = " Show LSP definitions", },
    { "gi", function() Snacks.picker.lsp_implementations() end, desc = " Show LSP implementations", },
    { "gy", function() Snacks.picker.lsp_type_definitions() end, desc = " Show LSP type definitions", },
    { "gs", function() Snacks.picker.lsp_symbols({ layout = "left" }) end, desc = " Show document symbols in floating picker", },
    { "gS", function() Snacks.picker.lsp_workspace_symbols() end, desc = " Show workspace symbols", },

    -- Search
    { "<leader>ff", function() Snacks.picker.files({ hidden = true }) end, desc = " Find files", },
    { "<leader>fg", function() Snacks.picker.grep() end, desc = " Grep in workspace", },
    { "<leader>fG", function() Snacks.picker.grep_buffers() end, desc = " Grep buffers" },
    { mode = { "n", "v" }, "<leader>fw", function() Snacks.picker.grep_word() end, desc = " Grep Word Under Cursor" },
    { "<leader>fb", function() Snacks.picker.buffers() end, desc = " List open buffers" },

    -- Git Pickers
    { "<leader>gl", function() Snacks.picker.git_log_file() end, desc = " Git Current File History" },
    { "<leader>gm", function() Snacks.picker.git_status() end, desc = " Git Find Status Files" },

    -- Diagnostics
    { "<leader>fd", function() Snacks.picker.diagnostics_buffer() end, desc = " Buffer diagnostics", },
    { "<leader>fD", function() Snacks.picker.diagnostics() end, desc = " Workspace diagnostics", },
    { "<leader>ft", function() Snacks.picker.todo_comments() end, desc = " Todo Comments", },

    -- Pickers
    { "<leader>fu", function() Snacks.picker.undo() end, desc = " Undo", },
    { "<leader>fh", function() Snacks.picker.help() end, desc = "󰘥 Help Pages", },
    { "<leader>fH", function() Snacks.picker.highlights() end, desc = " Highlights", },
    { "<leader>fS", function() Snacks.picker.colorschemes() end, desc = " Colorscheme picker", },
    { "<leader>fi", function() Snacks.picker.icons({ icon_sources = { "nerd_fonts" } }) end, desc = "  Nerd Font Icons picker", },
    { "<leader>fm", function() Snacks.picker.marks() end, desc = " Marks" },
    { "<leader>fj", function() Snacks.picker.jumps() end, desc = "󰹹 Jumps" },
    { "<leader>fr", function() Snacks.picker.registers() end, desc = " Registers" },
    { "<leader>fp", function() Snacks.picker.projects() end, desc = " Projects" },
    { "<leader>fc", function() Snacks.picker.command_history() end, desc = " Comandline History" },
    { "<leader>fC", function() Snacks.picker.commands() end, desc = " Commandline commands" },
  },

  -- Setup toggle mappings
  config = function(_, opts)
    require("snacks").setup(opts)

    local Snacks = require("snacks")

    Snacks.toggle.inlay_hints():map("<leader>uh", { desc = "󰅩 Toggle Inlay Hints" })
    Snacks.toggle.diagnostics():map("<leader>ud", { desc = " Toggle Diagnostics" })
    Snacks.toggle.option("spell"):map("<leader>us", { desc = "󰓆 Spell Checking" })
    Snacks.toggle.option("wrap"):map("<leader>uw", { desc = "󰖶 Word Wrap" })
    Snacks.toggle.option("relativenumber"):map("<leader>ul", { desc = "󰉻 Relative Line Numbers" })

    --stylua: ignore
    Snacks.toggle.option("conceallevel", { name = " Conceal", off = 0, on = vim.o.conceallevel > 0 and vim.o.conceallevel or 2 }):map("<leader>uc")
    --stylua: ignore
    Snacks.toggle.option("showtabline", { name = "󰓩 Tabline", off = 0, on = vim.o.showtabline > 0 and vim.o.showtabline or 2 }):map("<leader>ut")

    Snacks.toggle.zoom():map("<C-w>z", { desc = " Toggle Zoom Window" })
    Snacks.toggle.words():map("<leader>uW", { desc = "󰺯 Toggle Word Highlighting" })

    local function image_previews_enabled(buf)
      return vim.b[buf].snacks_image_previews ~= false
    end

    if not Snacks.image.inline._preview_toggle_patched then
      local inline_update = Snacks.image.inline.update
      Snacks.image.inline.update = function(self, ...)
        if not image_previews_enabled(self.buf) then
          Snacks.image.placement.clean(self.buf)
          return
        end
        return inline_update(self, ...)
      end

      local doc_hover = Snacks.image.doc.hover
      Snacks.image.doc.hover = function(...)
        if not image_previews_enabled(vim.api.nvim_get_current_buf()) then
          Snacks.image.doc.hover_close()
          return
        end
        return doc_hover(...)
      end

      Snacks.image.inline._preview_toggle_patched = true
    end

    local function refresh_image_previews(state)
      local buf = vim.api.nvim_get_current_buf()
      if not state then
        Snacks.image.doc.hover_close()
        Snacks.image.placement.clean(buf)
        return
      end

      local langs = Snacks.image.langs()
      local lang = vim.treesitter.language.get_lang(vim.bo[buf].filetype)
      if lang and vim.tbl_contains(langs, lang) then
        if vim.b[buf].snacks_image_attached then
          vim.api.nvim_exec_autocmds("BufWinEnter", { buffer = buf })
        else
          Snacks.image.doc.attach(buf)
        end
      end

      Snacks.image.doc.hover()
    end

    Snacks.toggle({
      name = "Image Previews",
      get = function()
        return image_previews_enabled(vim.api.nvim_get_current_buf())
      end,
      set = function(state)
        vim.b.snacks_image_previews = state
        refresh_image_previews(state)
      end,
    }):map("<leader>ui", { desc = " Toggle Image Previews" })

    Snacks.toggle({
      name = "Auto Format (Global)",
      get = function()
        return not vim.g.disable_autoformat
      end,
      set = function(state)
        vim.g.disable_autoformat = not state
        vim.b.disable_autoformat = false
      end,
    }):map("<leader>uf")

    Snacks.toggle({
      name = "Auto Format (Buffer)",
      get = function()
        return not vim.b.disable_autoformat
      end,
      set = function(state)
        vim.b.disable_autoformat = not state
      end,
    }):map("<leader>uF")
  end,

  init = function()
    local function disable_animate_for(key)
      vim.keymap.set("n", key, function()
        local prev_animate = vim.g.snacks_animate
        vim.g.snacks_animate = false
        vim.cmd("normal! " .. key)
        vim.schedule(function()
          vim.g.snacks_animate = prev_animate
        end)
      end, { noremap = true })
    end

    for _, key in ipairs({ "G", "gg", "n", "N" }) do
      disable_animate_for(key)
    end
  end,
}
