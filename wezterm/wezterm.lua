local wezterm = require("wezterm")
local action = wezterm.action
local config = {}

config.max_fps = 240
config.front_end = "WebGpu"
config.harfbuzz_features = { "calt=0", "clig=0", "liga=0" }
config.font = wezterm.font_with_fallback({
	{ family = "Hasklig" },
	{ family = "DM Mono" },
	{ family = "Space Mono" },
	{ family = "Fira Code" },
	{ family = "JetBrains Mono" },
	{ family = "Cascadia Mono" },
	{ family = "Rec Mono Duotone" },
	{ family = "Symbols Nerd Font Mono", scale = 0.8 },
})
config.font_size = 16.0
config.freetype_load_target = "Light"

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
		cursor_bg = "#f5e0dc",
		cursor_fg = "#11111b",
		cursor_border = "#f5e0dc",
		selection_bg = "#45475a",
		selection_fg = "#cdd6f4",
	},
}

config.color_scheme = "Catppuccin Noir"
config.colors = {
	cursor_bg = "#cba6f7",
	cursor_fg = "#1e1e2e",
	cursor_border = "#cba6f7",
	split = "#cba6f7",
}

config.window_background_opacity = 1
config.macos_window_background_blur = 20
config.text_background_opacity = 1
config.window_decorations = "RESIZE"
config.enable_tab_bar = false

config.default_cursor_style = "BlinkingBar"
config.cursor_blink_rate = 1000
config.force_reverse_video_cursor = false
config.animation_fps = 120
config.cursor_blink_ease_in = "Linear"
config.cursor_blink_ease_out = "Linear"

config.inactive_pane_hsb = {
	saturation = 0.95,
	brightness = 0.75,
}

local function theme_switcher(window, pane)
	local schemes = wezterm.get_builtin_color_schemes()
	local choices = {}

	for key, _ in pairs(schemes) do
		table.insert(choices, { label = tostring(key) })
	end

	table.sort(choices, function(c1, c2)
		return c1.label < c2.label
	end)

	window:perform_action(
		wezterm.action.InputSelector({
			title = "🎨 Pick a Theme!",
			choices = choices,
			fuzzy = true,
			action = wezterm.action_callback(function(inner_window, inner_pane, id, label)
				if label then
					local overrides = window:get_config_overrides() or {}
					overrides.color_scheme = label
					window:set_config_overrides(overrides)
				end
			end),
		}),
		pane
	)
end

config.keys = {
	{
		key = "T",
		mods = "ALT|SHIFT",
		action = wezterm.action_callback(theme_switcher),
	},
	-- Visal/copy mode
	{
		key = "c",
		mods = "ALT",
		action = wezterm.action.ActivateCopyMode,
	},

	-- Macos Text Navigation
	{
		key = "LeftArrow",
		mods = "ALT",
		action = wezterm.action({ SendString = "\x1bb" }),
	},
	{
		key = "RightArrow",
		mods = "ALT",
		action = wezterm.action({ SendString = "\x1bf" }),
	},
	{
		key = "LeftArrow",
		mods = "CMD",
		action = wezterm.action({ SendString = "\x01" }),
	},
	{
		key = "RightArrow",
		mods = "CMD",
		action = wezterm.action({ SendString = "\x05" }),
	},
	{
		key = "Backspace",
		mods = "CMD",
		action = wezterm.action.SendKey({ key = "u", mods = "CTRL" }),
	},

	-- Pane Management
	{
		key = "x",
		mods = "SHIFT|ALT",
		action = wezterm.action.CloseCurrentPane({ confirm = true }),
	},
	{
		key = "s",
		mods = "SHIFT|ALT",
		action = action.PaneSelect({ mode = "SwapWithActive" }),
	},
	{
		key = "r",
		mods = "SHIFT|ALT",
		action = action.RotatePanes("Clockwise"),
	},
	{
		key = "r",
		mods = "SHIFT|CMD|ALT",
		action = action.RotatePanes("CounterClockwise"),
	},

	-- Pane Splitting
	{
		key = "h",
		mods = "SHIFT|ALT",
		action = action.SplitHorizontal({ domain = "CurrentPaneDomain" }),
	},
	{
		key = "v",
		mods = "SHIFT|ALT",
		action = action.SplitVertical({ domain = "CurrentPaneDomain" }),
	},

	-- Pane Navigation
	{
		key = "LeftArrow",
		mods = "SHIFT|ALT",
		action = action.ActivatePaneDirection("Left"),
	},
	{
		key = "RightArrow",
		mods = "SHIFT|ALT",
		action = action.ActivatePaneDirection("Right"),
	},
	{
		key = "UpArrow",
		mods = "SHIFT|ALT",
		action = action.ActivatePaneDirection("Up"),
	},
	{
		key = "DownArrow",
		mods = "SHIFT|ALT",
		action = action.ActivatePaneDirection("Down"),
	},

	-- Change pane sizes
	{
		key = "LeftArrow",
		mods = "SHIFT|CMD|ALT",
		action = wezterm.action.AdjustPaneSize({ "Left", 5 }),
	},
	{
		key = "RightArrow",
		mods = "SHIFT|CMD|ALT",
		action = wezterm.action.AdjustPaneSize({ "Right", 5 }),
	},
	{
		key = "UpArrow",
		mods = "SHIFT|CMD|ALT",
		action = wezterm.action.AdjustPaneSize({ "Up", 5 }),
	},
	{
		key = "DownArrow",
		mods = "SHIFT|CMD|ALT",
		action = wezterm.action.AdjustPaneSize({ "Down", 5 }),
	},
	{
		key = "z",
		mods = "SHIFT|ALT",
		action = action.TogglePaneZoomState,
	},
}

return config
