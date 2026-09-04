import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve real installed Pi packages without installing or modifying dependencies.
const env = { ...process.env };
delete env.npm_config_prefix;
const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", env }).trim();
const parentURL = pathToFileURL(join(globalRoot, "@earendil-works/pi-coding-agent/package.json")).href;
registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(specifier, specifier.startsWith("@earendil-works/") ? { ...context, parentURL } : context);
	},
});
