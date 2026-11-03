-- Buffer-local, and set on LspAttach rather than on_attach: servers that ship
-- their own on_attach (clangd, rust_analyzer, eslint, …) would replace ours.
-- The native gr* keys are re-set only to add a desc for which-key.
vim.api.nvim_create_autocmd("LspAttach", {
  group = vim.api.nvim_create_augroup("user_lsp_keymaps", { clear = true }),
  callback = function(event)
    local function map(mode, lhs, rhs, desc)
      vim.keymap.set(mode, lhs, rhs, { buffer = event.buf, desc = desc })
    end

    --- The Snacks picker `name` when Snacks is loaded, otherwise `fallback`.
    local function pick(name, fallback)
      return function()
        if package.loaded.snacks then
          Snacks.picker[name]()
        else
          fallback()
        end
      end
    end

    map("n", "gd", pick("lsp_definitions", vim.lsp.buf.definition), " LSP Go to definition")
    map("n", "gD", pick("lsp_declarations", vim.lsp.buf.declaration), " LSP Go to declaration")
    map("n", "grr", pick("lsp_references", vim.lsp.buf.references), " LSP References")
    map("n", "gri", pick("lsp_implementations", vim.lsp.buf.implementation), " LSP Implementations")
    map("n", "grt", pick("lsp_type_definitions", vim.lsp.buf.type_definition), " LSP Type definition")
    map("n", "gO", pick("lsp_symbols", vim.lsp.buf.document_symbol), " LSP Document symbols")
    map("n", "gS", pick("lsp_workspace_symbols", vim.lsp.buf.workspace_symbol), " LSP Workspace symbols")

    map("n", "grn", vim.lsp.buf.rename, " LSP Rename")
    map({ "n", "x" }, "gra", vim.lsp.buf.code_action, " LSP Code action")
    map("n", "grx", vim.lsp.codelens.run, " LSP Run code lens")
    map("n", "K", vim.lsp.buf.hover, " LSP Hover")
    map("i", "<C-s>", vim.lsp.buf.signature_help, "󰊕 LSP Signature help")
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
