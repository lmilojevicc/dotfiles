/**
 * Locate the installed Pi package and its system-prompt builder without installing anything:
 * an explicit override first, then the managed install behind the `pi` launcher, then a global npm install.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE = "@earendil-works/pi-coding-agent";

export function piPackageRoot(): string {
	const candidates: string[] = [];
	if (process.env.PI_PACKAGE_ROOT) candidates.push(process.env.PI_PACKAGE_ROOT);
	try {
		const launcher = realpathSync(execFileSync("which", [process.env.PI_BIN ?? "pi"], { encoding: "utf8" }).trim());
		const install = join(dirname(dirname(launcher)), "install");
		const version = readFileSync(join(install, "current-version"), "utf8").trim();
		candidates.push(join(install, "releases", version, "node_modules", PACKAGE));
	} catch {
		// No managed launcher on PATH; try npm below.
	}
	try {
		const env = { ...process.env };
		delete env.npm_config_prefix;
		candidates.push(join(execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim(), PACKAGE));
	} catch {
		// npm may be unavailable.
	}
	const root = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
	if (!root) throw new Error(`Cannot find ${PACKAGE}. Set PI_PACKAGE_ROOT to the installed package directory.`);
	return root;
}

export interface SystemPromptBuilder {
	/** Render the prompt exactly as Pi replays it, so a forced prompt and structured sections stay distinguishable. */
	buildSystemPrompt(input: Record<string, unknown>): string;
}

/** Pi does not export prompt rendering from its package root; the installed module is the only public form. */
export async function loadSystemPromptBuilder(): Promise<SystemPromptBuilder> {
	return import(pathToFileURL(join(piPackageRoot(), "dist/core/system-prompt.js")).href) as Promise<SystemPromptBuilder>;
}
