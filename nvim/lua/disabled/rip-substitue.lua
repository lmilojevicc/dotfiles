return {
  "chrisgrieser/nvim-rip-substitute",
  cmd = "RipSubstitute",

  opts = {
    popupWin = { position = "top" },
  },

  --stylua: ignore 
  keys = {
    { "<leader>sr", function() require("rip-substitute").sub() end, mode = { "n", "x" }, desc = " rip substitute", },
  },
}
