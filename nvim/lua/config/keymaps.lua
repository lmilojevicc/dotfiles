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

-- Wrap the visual selection as a markdown link using the system clipboard as URL.
-- Usage: copy a URL, select text in visual mode, press <C-p> in a markdown buffer.
-- Reads the live selection via getregionpos() instead of the '< '> marks: those still
-- point at the previous selection while a new one is active (gv would re-wrap the
-- wrong text on repeated use). Same technique as mkdnflow.nvim's createLink().
local wrap_selection_as_markdown_link = function()
  local url = vim.fn.getreg("+"):gsub("^%s+", ""):gsub("%s+$", "")
  if url == "" then
    vim.notify("Clipboard is empty", vim.log.levels.WARN)
    return
  end
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" then
    vim.notify("Only characterwise/linewise visual mode supported", vim.log.levels.WARN)
    return
  end
  -- getregionpos: start[3] is 1-indexed inclusive; end[3] is 1-indexed inclusive,
  -- which equals the 0-indexed exclusive end that nvim_buf_set_text expects.
  local region = vim.fn.getregionpos(vim.fn.getpos("v"), vim.fn.getpos("."), { type = mode })
  local start_pos, end_pos = region[1][1], region[#region][2]
  local sr, sc = start_pos[2] - 1, start_pos[3] - 1
  local er, ec = end_pos[2] - 1, end_pos[3]
  local text = table.concat(vim.api.nvim_buf_get_text(0, sr, sc, er, ec, {}), "\n")
  if text == "" then
    vim.notify("Nothing selected", vim.log.levels.WARN)
    return
  end
  -- Percent-encode parens so unbalanced parens can't break CommonMark link parsing.
  url = url:gsub("%(", "%%28"):gsub("%)", "%%29")
  local replacement = "[" .. text .. "](" .. url .. ")"
  vim.api.nvim_buf_set_text(0, sr, sc, er, ec, { replacement })
  vim.api.nvim_feedkeys(vim.keycode("<Esc>"), "x", false)
  if sr == er then
    vim.api.nvim_win_set_cursor(0, { sr + 1, sc + #replacement })
  end
end

vim.api.nvim_create_autocmd("FileType", {
  pattern = { "markdown" },
  callback = function()
    vim.keymap.set("x", "<C-p>", wrap_selection_as_markdown_link, {
      buffer = true,
      desc = "Wrap selection as markdown link",
    })
  end,
})
