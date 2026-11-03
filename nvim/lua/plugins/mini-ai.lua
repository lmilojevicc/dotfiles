return {
  "nvim-mini/mini.ai",
  event = { "InsertEnter", "BufReadPost" },
  version = "*",
  dependencies = { "nvim-treesitter/nvim-treesitter-textobjects" },
  config = function()
    local ai = require("mini.ai")
    ai.setup({
      n_lines = 500,
      custom_textobjects = {
        f = ai.gen_spec.treesitter({ a = "@function.outer", i = "@function.inner" }),
        c = ai.gen_spec.treesitter({ a = "@class.outer", i = "@class.inner" }),
        -- mini.ai's own `f` was the function call; keep it as u so f can be the definition.
        u = ai.gen_spec.function_call(),
      },
    })
  end,
}
