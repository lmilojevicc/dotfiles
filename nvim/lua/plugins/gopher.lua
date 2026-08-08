local mason_bin = vim.fn.stdpath("data") .. "/mason/bin"

return {
  "olexsmir/gopher.nvim",
  ft = "go",
  ---@module "gopher"
  ---@type gopher.Config
  opts = {
    commands = {
      go = "go",
      gomodifytags = mason_bin .. "/gomodifytags",
      gotests = mason_bin .. "/gotests",
      impl = mason_bin .. "/impl",
      iferr = mason_bin .. "/iferr",
      json2go = mason_bin .. "/json2go",
    },
  },
  config = function(_, opts)
    local go = vim.fn.exepath("go")
    if go ~= "" then
      opts.commands.go = go

      local result = vim.system({ go, "env", "GOROOT" }, { text = true }):wait()
      local goroot = vim.trim(result.stdout or "")
      if result.code == 0 and goroot ~= "" then
        vim.env.GOROOT = goroot
      end
    end

    require("gopher").setup(opts)

    for _, cmd in ipairs({ "GoIfErr", "GoTagAdd", "GoTagRm", "GoTagClear" }) do
      pcall(vim.api.nvim_del_user_command, cmd)
    end
  end,
}
