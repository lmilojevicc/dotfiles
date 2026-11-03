return {
  "nvim-lualine/lualine.nvim",
  dependencies = {
    "nvim-tree/nvim-web-devicons",
    "catppuccin/nvim",
  },
  event = "BufReadPre",
  opts = function()
    local c = require("catppuccin.palettes").get_palette()

    -- git runs in the background at most every 5 s per repo; the statusline reads the cache.
    local git_counts = {}
    local function ahead_behind(branch)
      if branch == "" then
        return branch
      end
      local dir = vim.fn.expand("%:p:h")
      if dir == "" or vim.bo.buftype ~= "" then
        dir = vim.fn.getcwd()
      end
      local root = vim.fs.root(dir, ".git")
      if not root then
        return branch
      end
      local entry = git_counts[root] or { ahead = 0, behind = 0, time = 0 }
      git_counts[root] = entry
      local now = vim.uv.now()
      if not entry.running and now - entry.time > 5000 then
        entry.running, entry.time = true, now
        vim.system(
          { "git", "rev-list", "--left-right", "--count", "HEAD...@{upstream}" },
          { cwd = root, text = true },
          function(result)
            entry.running = false
            local ahead, behind = (result.stdout or ""):match("(%d+)%s+(%d+)")
            entry.ahead, entry.behind = tonumber(ahead) or 0, tonumber(behind) or 0
          end
        )
      end
      local indicators = (entry.ahead > 0 and "↑" .. entry.ahead or "")
        .. (entry.behind > 0 and "↓" .. entry.behind or "")
      return branch .. (indicators ~= "" and " " .. indicators or "")
    end
    return {
      options = {
        theme = "catppuccin-nvim",
        component_separators = "",
        section_separators = { left = "", right = "" },
        globalstatus = true,
      },

      sections = {
        lualine_a = {
          {
            "mode",
            icon = "",
          },
        },
        lualine_b = {},
        lualine_c = {
          {
            "filetype",
            icon_only = true,
            colored = false,
            color = { fg = c.blue },
            padding = { left = 1, right = 0 },
            fmt = function(str)
              if str == "" then
                return " "
              end
              return str
            end,
          },
          {
            "filename",
            icon_only = false,
            file_status = true,
            symbols = {
              modified = "●",
              readonly = "󰏮",
              unnamed = "",
            },
            padding = { right = 1, left = 0 },
            color = { fg = c.blue },
          },
          {
            "branch",
            icon = "󰘬",
            color = { fg = c.peach },
            fmt = ahead_behind,
          },
          {
            "diff",
            colored = true,
            symbols = { added = " ", modified = " ", removed = " " },
          },
          {
            "diagnostics",
            sources = { "nvim_diagnostic" },
            symbols = { error = " ", warn = " ", info = " ", hint = " " },
            colored = true,
            -- always_visible = true,
          },

          "%=",

          -- stylua: ignore
          {
            function() return " " .. require("dap").status() end,
            cond = function() return package.loaded["dap"] and require("dap").status() ~= "" end,
            color = { fg = c.red },
          },

          -- stylua: ignore
          {
            function() local reg = vim.fn.reg_recording() return reg ~= "" and "󰺕 " .. reg or "" end,
            cond = function() return vim.fn.reg_recording() ~= "" end,
            color = { fg = c.red },
          },
        },
        lualine_x = {
          {
            require("lazy.status").updates,
            cond = require("lazy.status").has_updates,
            color = { fg = c.blue },
          },
          -- Indentation
          {
            function()
              if vim.bo.expandtab then
                return "SPC " .. vim.bo.shiftwidth
              else
                return "TAB " .. vim.bo.tabstop
              end
            end,
            color = { fg = c.lavender },
          },
          -- Formatter status
          {
            function()
              local status, conform = pcall(require, "conform")
              if not status then
                return ""
              end

              local lsp_format = require("conform.lsp_format")

              local formatters = conform.list_formatters_for_buffer()
              if formatters and #formatters > 0 then
                local formatterNames = {}

                for _, formatter in ipairs(formatters) do
                  table.insert(formatterNames, formatter)
                end

                return "󰷈 " .. table.concat(formatterNames, " ")
              end

              local bufnr = vim.api.nvim_get_current_buf()
              local lsp_clients = lsp_format.get_format_clients({ bufnr = bufnr })

              if not vim.tbl_isempty(lsp_clients) then
                return "󰷈 LSP Formatter"
              end

              return ""
            end,
            color = { fg = c.rosewater },
            padding = 1,
          },
          {
            "lsp_status",
            icon = "",
            symbols = {
              spinner = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" },
              done = "✓",
              separator = " ",
            },
            padding = 1,
            color = { fg = c.pink },
          },
        },
        lualine_y = {},
        lualine_z = { "progress" },
      },
      inactive_sections = {
        lualine_a = {},
        lualine_b = {},
        lualine_y = {},
        lualine_z = {},
        lualine_c = {},
        lualine_x = {},
      },
    }
  end,
}
