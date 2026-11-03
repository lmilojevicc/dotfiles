-- Prompt for program arguments, starting from the configuration's own.
local function get_args(config)
  local args = type(config.args) == "function" and (config.args() or {}) or config.args or {}
  local args_str = type(args) == "table" and table.concat(args, " ") or args
  config = vim.deepcopy(config)
  config.args = function()
    local new_args = vim.fn.expand(vim.fn.input("Run with args: ", args_str))
    if config.type == "java" then
      return new_args
    end
    return require("dap.utils").splitstr(new_args)
  end
  return config
end

return {
  {
    "rcarriga/nvim-dap-ui",
    dependencies = { "nvim-neotest/nvim-nio" },
    opts = {},

    config = function(_, opts)
      local dap = require("dap")
      local dapui = require("dapui")

      dapui.setup(opts)
      dap.listeners.after.event_initialized["dapui_config"] = function()
        dapui.open({})
      end
    end,

    -- stylua: ignore
    keys = {
      { "<leader>du", function() require("dapui").toggle({ }) end, desc = " Dap UI" },
      { "<leader>de", function() require("dapui").eval() end, desc = " Eval", mode = {"n", "v"} },
    },
  },

  {
    "mfussenegger/nvim-dap",
    dependencies = {
      -- Loads with nvim-dap so its auto-open listener exists for the first session.
      "rcarriga/nvim-dap-ui",
      { "leolUz/nvim-dap-go", ft = "go" },
      { "mfussenegger/nvim-dap-python", ft = "python" },
      { "theHamsta/nvim-dap-virtual-text", opts = {} },
    },

    config = function()
      local dap = require("dap")

      require("dap-go").setup()
      require("dap-python").setup()
      dap.configurations.java = {
        {
          type = "java",
          request = "attach",
          name = "Debug (Attach) - Remote",
          hostName = "127.0.0.1",
          port = 5005,
        },
      }

      -- Icons
      local signs = {
        breakpoint = { text = " ", hl = "DapBreakpoint" },
        condition = { text = " ", hl = "DapBreakpointCondition" },
        log_point = { text = ".>", hl = "DapLogPoint" },
        stopped = { text = " ", hl = "DapStopped" },
        rejected = { text = " ", hl = "DapBreakpointRejected" },
      }

      for name, sign in pairs(signs) do
        vim.fn.sign_define("Dap" .. (name
          :gsub("_(%w)", function(c)
            return c:upper()
          end)
          :gsub("^%w", string.upper)), { text = sign.text, texthl = sign.hl })
      end
    end,

    -- stylua: ignore
    keys = {
      { "<leader>dB", function() require("dap").set_breakpoint(vim.fn.input('Breakpoint condition: ')) end, desc = " Breakpoint Condition" },
      { "<leader>db", function() require("dap").toggle_breakpoint() end, desc = " Toggle Breakpoint" },
      { "<leader>dc", function() require("dap").continue() end, desc = " Run/Continue" },
      { "<leader>da", function() require("dap").continue({ before = get_args }) end, desc = "  Run with Args" },
      { "<leader>dC", function() require("dap").run_to_cursor() end, desc = " Run to Cursor" },
      { "<leader>dg", function() require("dap").goto_() end, desc = " Go to Line (No Execute)" },
      { "<leader>di", function() require("dap").step_into() end, desc = " Step Into" },
      { "<leader>dj", function() require("dap").down() end, desc = " Down" },
      { "<leader>dk", function() require("dap").up() end, desc = " Up" },
      { "<leader>do", function() require("dap").step_out() end, desc = " Step Out" },
      { "<leader>dO", function() require("dap").step_over() end, desc = " Step Over" },
      { "<leader>dP", function() require("dap").pause() end, desc = " Pause" },
      { "<leader>dr", function() require("dap").repl.toggle() end, desc = " Toggle REPL" },
      { "<leader>ds", function() require("dap").session() end, desc = " Session" },
      { "<leader>dt", function() require("dap").terminate() end, desc = " Terminate" },
      { "<leader>dw", function() require("dap.ui.widgets").hover() end, desc = " Widgets" },
    },
  },
}
