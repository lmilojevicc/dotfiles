return {
  "rmagatti/goto-preview",
  event = "LspAttach",
  config = true,
  -- stylua: ignore 
  keys = {
    { "gpd", function () require('goto-preview').goto_preview_definition({}) end, desc = " Go to preview definition"},
    { "gpt", function () require('goto-preview').goto_preview_type_definition({}) end, desc = " Go to preview type definition"},
    { "gpi", function () require('goto-preview').goto_preview_implementation({}) end, desc = " Go to preview implementation"},
    { "gpD", function () require('goto-preview').goto_preview_declaration({}) end, desc = " Go to preview declaration"},
    { "gpr", function () require('goto-preview').goto_preview_references({}) end, desc = " Go to preview references"},
    { "gP", function () require('goto-preview').close_all_win({}) end, desc = " Go to preview close all windows"},
  },
}
