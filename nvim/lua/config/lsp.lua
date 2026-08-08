-- Keymaps
vim.lsp.config("*", {
  capabilities = vim.lsp.protocol.make_client_capabilities(),
  on_attach = function(client, bufnr)
    local map = vim.keymap.set

    local has_snacks = pcall(require, "snacks")
    local has_fzf = pcall(require, "fzf-lua")

    if not has_snacks and not has_fzf then
      map("n", "gd", vim.lsp.buf.definition, { desc = " LSP Go to definition" })
      map("n", "gD", vim.lsp.buf.declaration, { desc = " LSP Go to declaration" })
      map("n", "gr", vim.lsp.buf.references, { desc = " LSP Show references" })
      map("n", "gi", vim.lsp.buf.implementation, { desc = "  LSP Go to implementation" })
      map("n", "gy", vim.lsp.buf.type_definition, { desc = " LSP Go to type definition" })
      map("n", "gs", vim.lsp.buf.document_symbol, { desc = " LSP Document symbols" })
      map("n", "gS", vim.lsp.buf.workspace_symbol, { desc = " LSP Workspace symbols" })
    end

    map({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, { desc = " LSP Code actions" })
    map("n", "<leader>rn", vim.lsp.buf.rename, { desc = " LSP Rename" })
    map("n", "gh", vim.lsp.buf.hover, { desc = " LSP Hover" })
    map("n", "K", vim.lsp.buf.signature_help, { desc = "󰊕 LSP Signature help" })

    map("n", "<leader>fo", function()
      vim.lsp.buf.format({ async = true })
    end, { desc = "󰷉 LSP Format" })
    map("v", "<leader>fo", function()
      local start_row, _ = unpack(vim.api.nvim_buf_get_mark(0, "<"))
      local end_row, _ = unpack(vim.api.nvim_buf_get_mark(0, ">"))
      vim.lsp.buf.format({
        range = {
          ["start"] = { start_row, 0 },
          ["end"] = { end_row, 0 },
        },
        async = true,
      })
    end, { desc = "󰷉 LSP Range Formatting" })
  end,
})

-- Diagnostics
vim.diagnostic.config({
  virtual_text = {
    current_line = true,
    spacing = 4,
    prefix = "",
    format = function(diagnostic)
      local icons = {
        [vim.diagnostic.severity.ERROR] = " ",
        [vim.diagnostic.severity.WARN] = " ",
        [vim.diagnostic.severity.HINT] = " ",
        [vim.diagnostic.severity.INFO] = " ",
      }

      return string.format("%s %s", icons[diagnostic.severity] or "", diagnostic.message)
    end,
  },

  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = " ",
      [vim.diagnostic.severity.WARN] = " ",
      [vim.diagnostic.severity.HINT] = " ",
      [vim.diagnostic.severity.INFO] = " ",
    },
  },

  underline = true,
  severity_sort = true,
  update_in_insert = false,

  float = {
    source = true,
    focusable = true,
    style = "minimal",
    border = "rounded",
    header = "",
    prefix = "",
  },
})
