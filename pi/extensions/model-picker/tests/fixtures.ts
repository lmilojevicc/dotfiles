import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PickerModel } from "../domain.ts";

/** Real loader fixture: root is the isolated agent directory, separate from copied modules. */
export function extensionFixture(root: string, vimMode = false): string {
	const directory = join(root, "extension");
	mkdirSync(directory);
	for (const file of ["index.ts", "component.ts", "config.ts", "domain.ts", "favorites.ts", "persistence.ts", "package.json"]) {
		copyFileSync(new URL(`../${file}`, import.meta.url), join(directory, file));
	}
	writeFileSync(join(root, "model-picker.json"), JSON.stringify({ vimMode }));
	return join(directory, "index.ts");
}
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
