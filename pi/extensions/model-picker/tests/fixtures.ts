import type { PickerModel } from "../domain.ts";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";

export function model(provider: string, id: string, name = id): PickerModel {
	return {
		provider, id, name, api: "openai-completions", baseUrl: "http://invalid.test",
		reasoning: true, input: ["text", "image"], contextWindow: 128000, maxTokens: 16384,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	};
}
export const keys = () => new KeybindingsManager(TUI_KEYBINDINGS);
export const plainTheme = {
	fg: (_color: string, value: string) => value,
	bg: (_color: string, value: string) => value,
	bold: (value: string) => value,
};
