local ls = require("luasnip")
local s = ls.snippet
local i = ls.insert_node
local fmt = require("luasnip.extras.fmt").fmt

return {
  s(
    "iferrf",
    fmt(
      [[
if err != nil {{
  return fmt.Errorf("{}: %w", err)
}}
]],
      { i(1, "error description") }
    )
  ),
  s(
    "iferr",
    fmt(
      [[
if err != nil {{
   {} 
}}
]],
      { i(1) }
    )
  ),
}
