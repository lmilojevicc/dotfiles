import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PickerModel } from "./domain.ts";

type SelectionResult =
	| { status: "saved" }
	| { status: "not-switched" | "switch-failed" | "switched-not-saved"; error: string };

/** Native settings accepts arrays; refuse non-object roots before handing it a write. */
function validateGlobalRoot(agentDir: string): void {
	let content: string;
	try {
		content = readFileSync(join(agentDir, "settings.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (content === "") return; // Match native absent/empty-file semantics.
	const root: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
	if (!root || typeof root !== "object" || Array.isArray(root)) {
		throw new Error("Global settings.json must contain a JSON object");
	}
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export async function switchAndSave(
	pi: Pick<ExtensionAPI, "setModel">,
	ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">,
	model: PickerModel,
	agentDir = getAgentDir(),
): Promise<SelectionResult> {
	let settings: SettingsManager;
	try {
		validateGlobalRoot(agentDir);
		settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
		const errors = settings.drainErrors();
		if (errors.length) throw new Error(errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; "));
	} catch (error) {
		return { status: "not-switched", error: `Cannot load settings: ${message(error)}` };
	}
	try {
		if (!(await pi.setModel(model))) return { status: "not-switched", error: "No API key available for this model" };
	} catch (error) {
		// Pi can assign the live model before a later transcript write throws.
		return { status: "switch-failed", error: message(error) };
	}
	try {
		validateGlobalRoot(agentDir);
		settings.setDefaultModelAndProvider(model.provider, model.id);
		await settings.flush();
		const errors = settings.drainErrors();
		if (errors.length) throw new Error(errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; "));
		return { status: "saved" };
	} catch (error) {
		return { status: "switched-not-saved", error: message(error) };
	}
}
