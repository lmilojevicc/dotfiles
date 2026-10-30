// Suite-specific resolution on top of _test-support/register-loader.mjs: these tests fake Pi's SDK but
// run the real installed TUI, so transcript layout and key handling match the Pi under test.
import { registerHooks } from "node:module";
import { installedHost, resolveTui } from "./installed-host.mjs";

const tui = resolveTui(installedHost());
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-coding-agent") return { url: new URL("./mocks/pi-coding-agent.mjs", import.meta.url).href, shortCircuit: true };
		if (specifier === "@earendil-works/pi-tui") return { url: tui, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
