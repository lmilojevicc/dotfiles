import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ModelInstructions = Map<string, string[]>;

/** Owned Pi prompt section: Pi wraps its text in a `<model_instructions>` tag of the same name. */
export const PROMPT_SECTION = "model_instructions";

function warn(ctx: ExtensionContext, message: string): void {
	// BB drops notify in RPC mode, so a non-TUI host also gets stderr even when it has a UI.
	if (ctx.hasUI) ctx.ui.notify(message, "warning");
	if (ctx.mode !== "tui") console.error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseConfig(value: unknown): ModelInstructions {
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "models") || !isRecord(value.models)) {
		throw new Error('Expected an object containing only a "models" object.');
	}

	const models: ModelInstructions = new Map();
	for (const [key, instructions] of Object.entries(value.models)) {
		if (!key || key.trim() !== key) {
			throw new Error("Model keys must be non-empty, without surrounding whitespace.");
		}
		if (!Array.isArray(instructions) || instructions.some((item) => typeof item !== "string" || !item.trim())) {
			throw new Error(`Instructions for ${JSON.stringify(key)} must be an array of non-empty strings.`);
		}
		models.set(key, instructions.map((item: string) => item.trim()));
	}
	return models;
}

export function instructionsFor(models: ModelInstructions, model: { provider: string; id: string }): string[] {
	// A provider-specific entry replaces the model-wide entry, including [].
	return models.get(`${model.provider}/${model.id}`) ?? models.get(model.id) ?? [];
}

export const CONFIG_ENV_VAR = "PI_MODEL_INSTRUCTIONS_CONFIG";

/**
 * Config file lookup, in order:
 *   1. `PI_MODEL_INSTRUCTIONS_CONFIG` env var (expanded: `~/` → home, otherwise relative to cwd);
 *   2. `<agentDir>/model-instructions.json` — the unified location every extension config shares;
 *   3. `<extensionDir>/instructions.json` — legacy pre-unification location, kept so a
 *      checkout that has not been migrated yet keeps working. Remove after all machines migrated.
 */
export function resolveDefaultConfigPath(
	value: string | undefined = process.env[CONFIG_ENV_VAR],
	agentDir = getAgentDir(),
	legacyPath = new URL("./instructions.json", import.meta.url),
): string | URL {
	if (value) return value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : resolve(value);
	const unified = join(agentDir, "model-instructions.json");
	if (existsSync(unified)) return unified;
	return legacyPath;
}

function configLabel(configPath: string | URL): string {
	return typeof configPath === "string" ? configPath : configPath.pathname;
}

export default function modelInstructionsExtension(
	pi: ExtensionAPI,
	configPath: string | URL = resolveDefaultConfigPath(),
): void {
	let lastError: string | undefined;

	pi.on("before_agent_start", (event, ctx) => {
		let models: ModelInstructions;
		try {
			models = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
			lastError = undefined;
		} catch (error) {
			// Removing the file intentionally disables all model-specific instructions.
			if (isRecord(error) && error.code === "ENOENT") {
				lastError = undefined;
				delete event.systemPromptOptions.sections[PROMPT_SECTION];
				return;
			}
			const reason = error instanceof Error ? error.message : String(error);
			const message = `Model instructions skipped (${configLabel(configPath)}): ${reason}`;
			if (message !== lastError) {
				warn(ctx, message);
				lastError = message;
			}
			return;
		}

		// Pi rebuilds the base prompt options for each run; never persist model-specific text
		// into session messages, where it could leak into a later model's context.
		const instructions = ctx.model ? instructionsFor(models, ctx.model) : [];
		if (instructions.length === 0) {
			delete event.systemPromptOptions.sections[PROMPT_SECTION];
			return;
		}
		// Mutate the section instead of returning systemPrompt: a returned prompt forces the whole
		// text for that run and silently drops every section later handlers add.
		event.systemPromptOptions.sections[PROMPT_SECTION] =
			`## Model-specific instructions\n\n${instructions.map((text) => `- ${text}`).join("\n")}`;
	});
}
