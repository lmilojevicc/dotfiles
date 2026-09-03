/** Settings surface adapted from @tintinweb/pi-tasks 0.9.0. */
import { getSettingsListTheme, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { saveTasksConfig, type TaskDisplayConfig } from "../config/tasks-config.js";
import { BUILT_IN_SORT_ORDERS } from "./task-sort.js";

export const DISPLAY_SETTING_ITEMS = [
	{
		id: "collapseCompleted", label: "Collapse completed tasks",
		description: "When ON, completed tasks are replaced by a single 'N completed' line and the visible limit applies only to the tasks left. When OFF, they are listed individually.",
	},
	{
		id: "showAll", label: "Show all tasks in widget",
		description: "When ON, every listed task is shown regardless of the visible limit. When OFF, the list is capped by 'Max visible tasks'.",
	},
	{
		id: "maxVisible", label: "Max visible tasks in widget",
		description: "Only applies when 'Show all tasks' is OFF. Caps how many task lines the widget shows.",
	},
	{
		id: "sortOrder", label: "Widget sort order",
		description: '"active" groups by in-progress → pending → completed; "status" is the reverse. "id" sorts by creation order. A custom sort spec in tasks-config.json shows as "custom" and can only be changed there.',
	},
	{
		id: "hiddenAt", label: "Hidden tasks position",
		description: '"bottom" hides tasks from the end of the list. "top" hides tasks from the start (useful with status sort to collapse completed tasks).',
	},
] as const;

export async function openSettingsMenu(
	ui: Pick<ExtensionUIContext, "custom" | "notify">,
	config: TaskDisplayConfig,
	cwd: string,
	onChange: (config: TaskDisplayConfig) => void,
): Promise<void> {
	await ui.custom<void>((_tui, theme, _keybindings, done) => {
		const customSort = Array.isArray(config.sortOrder);
		const items: SettingItem[] = [
			{ ...DISPLAY_SETTING_ITEMS[0], currentValue: config.collapseCompleted ? "on" : "off", values: ["on", "off"] },
			{ ...DISPLAY_SETTING_ITEMS[1], currentValue: config.showAll ? "on" : "off", values: ["on", "off"] },
			{ ...DISPLAY_SETTING_ITEMS[2], currentValue: String(config.maxVisible), values: ["5", "10", "15", "20", "30", "50", "100"] },
			{ ...DISPLAY_SETTING_ITEMS[3], currentValue: customSort ? "custom" : config.sortOrder as string, values: [...BUILT_IN_SORT_ORDERS] },
			{ ...DISPLAY_SETTING_ITEMS[4], currentValue: config.hiddenAt, values: ["bottom", "top"] },
		];
		const list = new SettingsList(items, 10, getSettingsListTheme(), (id, value) => {
			const previous = { ...config };
			if (id === "collapseCompleted") config.collapseCompleted = value === "on";
			else if (id === "showAll") config.showAll = value === "on";
			else if (id === "maxVisible") config.maxVisible = Number(value);
			else if (id === "sortOrder") config.sortOrder = value as TaskDisplayConfig["sortOrder"];
			else if (id === "hiddenAt") config.hiddenAt = value as "top" | "bottom";
			try {
				saveTasksConfig(config, cwd);
				onChange(config);
			} catch (error) {
				Object.assign(config, previous);
				const restored = id === "collapseCompleted" ? (config.collapseCompleted ? "on" : "off")
					: id === "showAll" ? (config.showAll ? "on" : "off")
						: id === "maxVisible" ? String(config.maxVisible)
							: id === "sortOrder" ? (Array.isArray(config.sortOrder) ? "custom" : config.sortOrder)
								: config.hiddenAt;
				list.updateValue(id, restored);
				ui.notify(`Could not save task settings: ${String(error)}`, "error");
			}
		}, () => done(undefined), { enableSearch: false });

		class SettingsPanel extends Container {
			handleInput(data: string): void { list.handleInput(data); }
		}
		const panel = new SettingsPanel();
		panel.addChild(new Text(theme.bold(theme.fg("accent", "⚙  Task Settings")), 0, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(list);
		return panel;
	});
}
