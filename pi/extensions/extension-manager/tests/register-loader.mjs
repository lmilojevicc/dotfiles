import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const env = { ...process.env };
delete env.npm_config_prefix;
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim();
const parentURL = pathToFileURL(join(globalRoot, "@earendil-works/pi-coding-agent/package.json")).href;
const home = mkdtempSync(join(tmpdir(), "extension-manager-test-home-"));
const agentDir = join(home, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.HOME = home;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => rmSync(home, { recursive: true, force: true }));

registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier, specifier.startsWith("@earendil-works/") ? { ...context, parentURL } : context);
	},
});
