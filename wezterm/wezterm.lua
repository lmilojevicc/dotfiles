local wezterm = require("wezterm")
local act = wezterm.action
local config = {}

-- Check if we're running on macOS
local is_macos = wezterm.target_triple:find("darwin") ~= nil

-- Define key modifiers as variables for readability
local SHIFT_ALT = "SHIFT|ALT"
local SHIFT_CMD_ALT = "SHIFT|CMD|ALT"

-- Performance settings
config.max_fps = 240
config.animation_fps = 240
config.front_end = "WebGpu"

-- Font configuration
config.harfbuzz_features = { "calt=0", "clig=0", "liga=0", "ss01=1", "ss02=1" }
config.font = wezterm.font_with_fallback({
	{ family = "Maple Mono NF" },
	{ family = "Consolas For Powerline" },
	{ family = "Sometype Mono" },
	{ family = "Fragment Mono" },
	{ family = "Geist Mono" },
	{ family = "Hasklig" },
	{ family = "DM Mono" },
	{ family = "Fira Code" },
	{ family = "JetBrains Mono" },
	{ family = "Symbols Nerd Font Mono", scale = 0.8 },
})
config.font_size = 16.0
config.freetype_load_target = "Light"
config.cell_width = 1.0
config.line_height = 1

-- Window appearance
config.window_background_opacity = 1
config.text_background_opacity = 1
config.window_decorations = "RESIZE"
config.window_padding = { left = 8, right = 8, top = 8, bottom = 8 }
config.enable_tab_bar = false
config.enable_scroll_bar = false

-- macOS specific settings
if is_macos then
	config.macos_window_background_blur = 20
	config.native_macos_fullscreen_mode = false
	config.use_ime = true
end

-- Cursor settings
config.default_cursor_style = "BlinkingBar"
config.cursor_blink_rate = 800
config.force_reverse_video_cursor = false
config.cursor_blink_ease_in = "Linear"
config.cursor_blink_ease_out = "Linear"
config.hide_mouse_cursor_when_typing = true

-- Inactive pane appearance
config.inactive_pane_hsb = {
	saturation = 0.95,
	brightness = 0.80,
}

-- Color schemes
config.color_schemes = {
	["Catppuccin Noir"] = {
		-- ANSI colors
		ansi = {
			"#1e2229",
			"#f38ba8",
			"#a6e3a1",
			"#f9e2af",
			"#89b4fa",
			"#cba6f7",
			"#94e2d5",
			"#bac2de",
		},
		brights = {
			"#45475a",
			"#f38ba8",
			"#a6e3a1",
			"#f9e2af",
			"#89b4fa",
			"#cba6f7",
			"#94e2d5",
			"#a6adc8",
		},

		-- Terminal colors
		background = "#11111b",
		foreground = "#cdd6f4",
		selection_bg = "#45475a",
		selection_fg = "#cdd6f4",
	},
}

config.color_scheme = "Catppuccin Noir"
config.colors = {
	cursor_bg = "#cba6f7",
	cursor_fg = "#11111b",
	cursor_border = "#cba6f7",
	split = "#313244",
	tab_bar = {
		background = "#11111b",
		active_tab = { bg_color = "#1e1e2e", fg_color = "#cdd6f4" },
		inactive_tab = { bg_color = "#11111b", fg_color = "#7f849c" },
	},
}

-- Keybindings
config.keys = {
	-- Copy mode
	{ key = "c", mods = SHIFT_ALT, action = act.ActivateCopyMode },

	-- macOS text navigation
	{ key = "LeftArrow", mods = "ALT", action = act.SendString("\x1bb") },
	{ key = "RightArrow", mods = "ALT", action = act.SendString("\x1bf") },
	{ key = "LeftArrow", mods = "CMD", action = act.SendString("\x01") },
	{ key = "RightArrow", mods = "CMD", action = act.SendString("\x05") },
	{ key = "Backspace", mods = "CMD", action = act.SendKey({ key = "u", mods = "CTRL" }) },

	-- Pane management
	{ key = "x", mods = SHIFT_ALT, action = act.CloseCurrentPane({ confirm = true }) },
	{ key = "s", mods = SHIFT_ALT, action = act.PaneSelect({ mode = "SwapWithActive" }) },
	{ key = "r", mods = SHIFT_ALT, action = act.RotatePanes("Clockwise") },
	{ key = "r", mods = SHIFT_CMD_ALT, action = act.RotatePanes("CounterClockwise") },

	-- Pane splitting
	{ key = "v", mods = SHIFT_ALT, action = act.SplitHorizontal({ domain = "CurrentPaneDomain" }) },
	{ key = "h", mods = SHIFT_ALT, action = act.SplitVertical({ domain = "CurrentPaneDomain" }) },

	-- Pane navigation
	{ key = "LeftArrow", mods = SHIFT_ALT, action = act.ActivatePaneDirection("Left") },
	{ key = "RightArrow", mods = SHIFT_ALT, action = act.ActivatePaneDirection("Right") },
	{ key = "UpArrow", mods = SHIFT_ALT, action = act.ActivatePaneDirection("Up") },
	{ key = "DownArrow", mods = SHIFT_ALT, action = act.ActivatePaneDirection("Down") },

	-- Pane resizing
	{ key = "LeftArrow", mods = SHIFT_CMD_ALT, action = act.AdjustPaneSize({ "Left", 5 }) },
	{ key = "RightArrow", mods = SHIFT_CMD_ALT, action = act.AdjustPaneSize({ "Right", 5 }) },
	{ key = "UpArrow", mods = SHIFT_CMD_ALT, action = act.AdjustPaneSize({ "Up", 5 }) },
	{ key = "DownArrow", mods = SHIFT_CMD_ALT, action = act.AdjustPaneSize({ "Down", 5 }) },

	-- Toggle zoom
	{ key = "z", mods = SHIFT_ALT, action = act.TogglePaneZoomState },
}

return config
