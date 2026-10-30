import contextUsageExtension from "../index.ts";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { projectionOf } from "./session-projection.ts";

// Semantic ANSI adapter: each color is distinct and fixed, independent of the user's theme.
// It intentionally emits complete SGR wrappers, including for empty bar segments.
const foreground: Record<string, number> = {
	accent: 201,
	border: 202,
	muted: 203,
	error: 204,
	warning: 205,
	success: 206,
	customMessageLabel: 207,
	dim: 208,
	text: 209,
};
const background: Record<string, number> = { selectedBg: 211, customMessageBg: 212 };
const theme = {
	fg: (color: string, text: string) => `\x1b[38;5;${foreground[color]}m${text}\x1b[39m`,
	bg: (color: string, text: string) => `\x1b[48;5;${background[color]}m${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

export async function captureRootHome() {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	contextUsageExtension({
		registerCommand: (name: string, options: any) => {
			if (name !== "context") throw new Error(`Unexpected command: ${name}`);
			handler = options.handler;
		},
		getAllTools: () => [{ name: "fixture_tool", description: "Fixture tool", parameters: { type: "object" } }],
	} as any);
	if (!handler) throw new Error("/context was not registered");
	const skills = [{ name: "fixture-skill", description: "Fixture skill", filePath: "/fixture/SKILL.md" }];
	const memory = "MEMORY_SEED_LONG";
	const prompt = `Fixture system prompt with ${memory}.\n${formatSkillsForPrompt(skills).trim()}`;
	const captures: Array<{ width: number; state: string; lines: string[] }> = [];
	const options: unknown[] = [];
	const tui = {
		mode: "inline",
		terminal: { rows: 24, columns: 80 },
		requestRender() {},
	};
	const ctx = {
		mode: "tui",
		getContextUsage: () => ({ tokens: 180, percent: null, contextWindow: 256 }),
		getSystemPrompt: () => prompt,
		getSystemPromptOptions: () => ({ selectedTools: ["fixture_tool"], contextFiles: [{ path: "AGENTS.md", content: memory }], skills }),
		sessionManager: { buildSessionProjection: () => projectionOf([
			{ type: "message", message: { role: "toolResult", toolCallId: "1", toolName: "fixture_tool", content: "tool output seed", isError: false } },
			{ type: "custom_message", customType: "fixture", content: "conversation seed" },
		]) },
		ui: {
			custom: (factory: any, config: unknown) => new Promise<void>((resolve) => {
				options.push(config);
				const component = factory(tui, theme, null, resolve);
				for (const width of [64, 44]) {
					const record = (state: string) => captures.push({ width, state, lines: component.render(width) });
					record("initial");
					component.handleInput("\x1b[B"); // Down selects Memory.
					record("selected-memory");
					component.handleInput("\x1b[A"); // Up restores System prompt.
					// Shared 21-row frame starts at row 2; Memory is row 9.
					component.handleMouse({ type: "move", screenX: 30, screenY: 8 });
					record("hover-memory");
					// Title row 3, [esc] at the right edge of the dialog.
					component.handleMouse({ type: "move", screenX: (80 - width) / 2 + width - 3, screenY: 2 });
					record("hover-esc");
					component.handleMouse({ type: "move", screenX: 0, screenY: 0 });
				}
				component.handleInput("\x1b");
			}),
		},
	};
	await handler("", ctx);
	return { options, captures };
}
