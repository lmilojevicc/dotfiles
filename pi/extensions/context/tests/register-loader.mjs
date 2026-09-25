import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

// npm --prefix sets npm_config_prefix for scripts, which changes `npm root -g` to a local path.
const npmEnv = { ...process.env };
delete npmEnv.npm_config_prefix;
const globalModules = `${execFileSync("npm", ["root", "-g"], { encoding: "utf8", env: npmEnv }).trim()}/@earendil-works`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent" || specifier === "@earendil-works/pi-tui") {
			return {
				url: pathToFileURL(`${realpathSync(`${globalModules}/${specifier.split("/")[1]}`)}/dist/index.js`).href,
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});
