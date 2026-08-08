local map = vim.keymap.set

map("n", "<Esc>", ":noh<CR><Esc>", { noremap = true, silent = true })

map("n", "<leader>qq", "<cmd>qa<cr>", { desc = " Quit All" })
map("t", "<Esc><Esc>", "<C-\\><C-n>", { desc = " Exit terminal mode" })

-- Vim native file navigation
map("n", "<leader>ee", ":Explore<CR>", { desc = " Open file explorer" })
map("n", "<leader>ff", ":find ", { desc = " Find file" })

-- Keep selection after indent
map("v", "<", "<gv", { desc = " Indent left and keep selection" })
map("v", ">", ">gv", { desc = " Indent right and keep selection" })

-- Buffers
map("n", "]b", "<cmd>bnext<CR>", { desc = " Go to next buffer" })
map("n", "[b", "<cmd>bprevious<CR>", { desc = " Go to previous buffer" })
map("n", "<leader>bd", ":bd<CR>", { desc = " Delete buffer", remap = true })

local diagnostic_goto = function(next, severity)
  local count = next and 1 or -1
  severity = severity and vim.diagnostic.severity[severity] or nil
  return function()
    vim.diagnostic.jump({ count = count, severity = severity, float = true })
  end
end

map("n", "]d", diagnostic_goto(true), { desc = " Next Diagnostic" })
map("n", "[d", diagnostic_goto(false), { desc = " Prev Diagnostic" })
map("n", "]e", diagnostic_goto(true, "ERROR"), { desc = " Next Error" })
map("n", "[e", diagnostic_goto(false, "ERROR"), { desc = " Prev Error" })
map("n", "]w", diagnostic_goto(true, "WARN"), { desc = " Next Warning" })
map("n", "[w", diagnostic_goto(false, "WARN"), { desc = " Prev Warning" })

map("n", "n", "'Nn'[v:searchforward].'zv'", { expr = true, desc = " Next Search Result" })
map("x", "n", "'Nn'[v:searchforward]", { expr = true, desc = " Next Search Result" })
map("o", "n", "'Nn'[v:searchforward]", { expr = true, desc = " Next Search Result" })
map("n", "N", "'nN'[v:searchforward].'zv'", { expr = true, desc = " Prev Search Result" })
map("x", "N", "'nN'[v:searchforward]", { expr = true, desc = " Prev Search Result" })
map("o", "N", "'nN'[v:searchforward]", { expr = true, desc = " Prev Search Result" })
