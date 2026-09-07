import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { __testing } from "../index.ts";

const theme: any = { fg: (color: string, text: string) => `\x1b[${color === "accent" ? "36" : color === "warning" ? "33" : "37"}m${text}\x1b[0m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const widths = [32, 39, 40, 41, 59, 60, 61, 64, 65, 66, 79, 80, 81];

const tabs = [
	{
		name: "fast", label: "Fast mode", format: __testing.formatFastLines,
		fullRule: "Fast service tier on Codex requests · served tier unobserved",
		shortRule: "Fast tier · served tier unobserved", offRule: "Standard processing",
	},
	{
		name: "compaction", label: "Server compaction", format: __testing.formatCompactionLines,
		fullRule: "Server-side compaction for Codex sessions · falls back to local",
		shortRule: "Codex sessions · local fallback", offRule: "Pi compacts sessions locally",
	},
] as const;

const states = [
	{ name: "off", enabled: false, status: "" },
	{ name: "on", enabled: true, status: "" },
	{ name: "on-ineligible", enabled: true, status: "Requires a Codex model" },
	{ name: "off-ineligible", enabled: false, status: "" },
	{ name: "save-error", enabled: true, status: "Could not save setting" },
] as const;

for (const tab of tabs) for (const width of widths) {
	test(`${tab.name} value/rule/status layout with ANSI cell utilities at ${width}`, () => {
		for (const state of states) {
			const lines = tab.format(theme, state.enabled, state.status, width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${tab.name}/${state.name}: ${visibleWidth(line)} > ${width}`);
			const plain = lines.map(stripVTControlCharacters);
			const text = plain.join("\n");
			assert.equal(plain[0], `  ${tab.label}  ${state.enabled ? "on" : "off"}`, "complete value row, never clipped");
			assert.equal(lines.length, state.status ? 4 : 2, "value row, at most one muted rule, at most one status");
			assert.doesNotMatch(text, /\n\s*\n\s*\n/, "single blank sections only");
			assert.doesNotMatch(text, /Globally|global|persists|Enter or Space|Enter\/Space|subsequent canonical|This setting|backend may still|Current model is ineligible/i, "no boilerplate walls");
			const rule = plain[1]!;
			if (state.enabled) {
				if (width - 2 >= visibleWidth(tab.fullRule)) assert.equal(rule, `  ${tab.fullRule}`);
				else if (width - 2 >= visibleWidth(tab.shortRule)) assert.equal(rule, `  ${tab.shortRule}`);
				else {
					assert.ok(rule.endsWith("…"), "clipped rule signals truncation instead of wrapping");
					assert.ok(tab.shortRule.startsWith(stripVTControlCharacters(rule).trim().slice(0, -1)), "clipped rule is a prefix");
				}
			} else {
				assert.ok(rule.includes(tab.offRule), "off state describes the untouched behavior");
			}
			if (state.status) assert.equal(plain[3], `  ${state.status}`, "status short and complete");
		}
	});
}

for (const tab of tabs) {
	test(`${tab.name} rule abbreviates at the exact full/short breakpoints`, () => {
		const fullWidth = visibleWidth(tab.fullRule) + 2;
		const at = (width: number) => stripVTControlCharacters(tab.format(theme, true, "", width)[1]!);
		assert.equal(at(fullWidth), `  ${tab.fullRule}`, "full rule at first fitting width");
		assert.equal(at(fullWidth - 1) === `  ${tab.fullRule}`, false, "one column under the breakpoint abbreviates");
		const shortWidth = visibleWidth(tab.shortRule) + 2;
		if (shortWidth < fullWidth) assert.equal(at(shortWidth), `  ${tab.shortRule}`);
	});
}
