return {
  "catgoose/nvim-colorizer.lua",
  event = "BufReadPre",
  opts = {
    filetypes = { "*" },
    user_default_options = {
      rgb_fn = true,
      hsl_fn = true,
      css = true,
      mode = "virtualtext",
      tailwind = true,
      virtualtext = "■",
      virtualtext_inline = true,
      virtualtext_mode = "foreground",
      always_update = true,
      names = false,
    },
  },
}
