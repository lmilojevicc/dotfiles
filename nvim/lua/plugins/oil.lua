return {
  "stevearc/oil.nvim",
  dependencies = {
    "nvim-tree/nvim-web-devicons",
    "malewicz1337/oil-git.nvim",
    "JezerM/oil-lsp-diagnostics.nvim",
  },

  opts = {
    float = {
      max_width = 0.6,
      max_height = 0.6,
      border = "single",
    },
    ssh = {
      border = "single",
    },
    keymaps_help = {
      border = "single",
    },
    default_file_explorer = true,
    view_options = {
      show_hidden = true,
    },
    win_options = {
      signcolumn = "yes:2",
    },
  },

  config = function(_, opts)
    require("oil").setup(opts)
    require("oil-git").setup({
      symbol_position = "signcolumn",
    })
    require("oil-lsp-diagnostics").setup({
      diagnostic_symbols = {
        error = " ",
        warn = " ",
        info = " ",
        hint = " 󰌶",
      },
    })

    local oil_winid = nil

    -- Function to update oil border colors
    local function update_oil_border()
      if oil_winid and vim.api.nvim_win_is_valid(oil_winid) then
        local bufnr = vim.api.nvim_win_get_buf(oil_winid)
        local highlight = vim.bo[bufnr].modified and "FloatBorder:OilBorderModified" or "FloatBorder:OilBorderNormal"
        vim.api.nvim_set_option_value("winhighlight", highlight, { win = oil_winid })

        -- Also update preview window if it exists
        if preview_winid and vim.api.nvim_win_is_valid(preview_winid) then
          vim.api.nvim_set_option_value("winhighlight", highlight, { win = preview_winid })
        end
      end
    end

    -- Track oil main window
    vim.api.nvim_create_autocmd({ "BufEnter", "WinEnter" }, {
      pattern = "oil://*",
      callback = function()
        oil_winid = vim.api.nvim_get_current_win()
        update_oil_border()
      end,
    })

    -- Track preview window creation
    vim.api.nvim_create_autocmd("WinEnter", {
      callback = function()
        local win = vim.api.nvim_get_current_win()

        -- Check if this is a preview window (has previewwindow option set)
        if vim.wo[win].previewwindow then
          preview_winid = win
          update_oil_border()
        end
      end,
    })

    -- Update border when buffer is modified
    vim.api.nvim_create_autocmd({ "BufModifiedSet", "TextChanged", "TextChangedI" }, {
      pattern = "oil://*",
      callback = update_oil_border,
    })

    -- Clean up on leave
    vim.api.nvim_create_autocmd("BufLeave", {
      pattern = "oil://*",
      callback = function()
        oil_winid = nil
      end,
    })

    vim.api.nvim_create_autocmd("WinClosed", {
      callback = function(args)
        local closed_win = tonumber(args.match)
        if closed_win == preview_winid then
          preview_winid = nil
        end
      end,
    })

    vim.api.nvim_create_autocmd("User", {
      pattern = "OilEnter",
      callback = vim.schedule_wrap(function(args)
        local oil = require("oil")
        if vim.api.nvim_get_current_buf() == args.data.buf and oil.get_cursor_entry() then
          oil.open_preview()
        end
      end),
    })
  end,

  --stylua: ignore
  keys = {
    { "<leader>oi", function() require("oil").toggle_float() end, desc = "󰿸 Open Floating Oil Nvim", },
  },
}
