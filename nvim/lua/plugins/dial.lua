return {
  "monaqa/dial.nvim",
  keys = {
    { "<C-a>", mode = { "n", "v" } },
    { "<C-x>", mode = { "n", "v" } },
    { "g<C-a>", mode = { "v" } },
    { "g<C-x>", mode = { "v" } },
  },
  config = function()
    local augend = require("dial.augend")

    require("dial.config").augends:register_group({
      default = {
        augend.integer.alias.decimal, -- Decimal integers
        augend.integer.alias.hex, -- Hexadecimal integers
        augend.date.alias["%Y/%m/%d"], -- Date format YYYY/MM/DD
        augend.date.alias["%m/%d/%Y"], -- Date format MM/DD/YYYY
        augend.date.alias["%d/%m/%Y"], -- Date format DD/MM/YYYY
        augend.constant.alias.bool, -- true <-> false
        augend.constant.new({
          elements = { "and", "or" },
          word = true,
          cyclic = true,
        }),
        augend.constant.new({
          elements = { "&&", "||" },
          word = false,
          cyclic = true,
        }),
      },
      visual = {
        augend.integer.alias.decimal,
        augend.integer.alias.hex,
        augend.date.alias["%Y/%m/%d"],
        augend.constant.alias.alpha, -- a -> b -> c
        augend.constant.alias.Alpha, -- A -> B -> C
      },
    })

    local map = vim.keymap.set
    local dial_map = require("dial.map")
    map("n", "<C-a>", dial_map.inc_normal(), { noremap = true })
    map("n", "<C-x>", dial_map.dec_normal(), { noremap = true })
    map("v", "<C-a>", dial_map.inc_visual(), { noremap = true })
    map("v", "<C-x>", dial_map.dec_visual(), { noremap = true })
    map("v", "g<C-a>", dial_map.inc_gvisual(), { noremap = true })
    map("v", "g<C-x>", dial_map.dec_gvisual(), { noremap = true })
    vim.keymap.set("v", "g<C-x>", dial_map.dec_gvisual(), { noremap = true })
  end,
}
